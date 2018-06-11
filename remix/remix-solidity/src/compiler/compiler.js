'use strict'

var solc = require('solc/wrapper')
var solcABI = require('solc/abi')

var webworkify = require('webworkify')

var compilerInput = require('./compiler-input')

var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager

var txHelper = require('./txHelper')

/*
  trigger compilationFinished, compilerLoaded, compilationStarted, compilationDuration
*/
function Compiler (handleImportCall) {
  var self = this
  this.event = new EventManager()

  var compileJSON

  var worker = null

  var currentVersion

  var optimize = false

  var compileToIELE = false

  this.setOptimize = function (_optimize) {
    optimize = _optimize
  }

  var compilationStartTime = null
  this.event.register('compilationFinished', (success, data, source) => {
    if (success && compilationStartTime) {
      this.event.trigger('compilationDuration', [(new Date().getTime()) - compilationStartTime])
    }
    compilationStartTime = null
  })

  this.event.register('compilationStarted', () => {
    compilationStartTime = new Date().getTime()
  })

  var internalCompile = function (files, target, missingInputs) {
    if (target.endsWith('.sol')) { // solidity 
      gatherImports(files, target, missingInputs, function (error, input) {
        if (error) {
          self.lastCompilationResult = null
          self.event.trigger('compilationFinished', [false, {'error': { formattedMessage: error, severity: 'error' }}, files])
        } else {
          compileJSON(input, optimize ? 1 : 0)
        }
      })
    } else { // iele 
      compileIELE(files, target)
    }
  }

  var compile = function (files, target, compileToIELE_) {
    compileToIELE = compileToIELE_
    self.event.trigger('compilationStarted', [])
    internalCompile(files, target)
  }
  this.compile = compile

  function setCompileJSON (_compileJSON) {
    compileJSON = _compileJSON
  }
  this.setCompileJSON = setCompileJSON // this is exposed for testing

  function onCompilerLoaded (version) {
    currentVersion = version
    self.event.trigger('compilerLoaded', [version])
  }

  function compileSolidityToIELE(result, source, cb) {
    console.log('@compileSolidityToIELE', result, source)
    const apiGateway = 'https://5c177bzo9e.execute-api.us-east-1.amazonaws.com/prod'
    const params = [source.target, {}]
    const sources = source.sources
    for (const filePath in sources) {
      params[1][filePath] = sources[filePath].content
    }
    window['fetch'](apiGateway, {
      method: 'POST',
      cors: true,
      body: JSON.stringify({
        method: 'sol2iele_asm',
        params: params,
        jsonrpc: '2.0'
      })
    })
    .then(response=>response.json())
    .then(json => {
      if (json['result'] && !json['error']) {
        let result = json['result']
        const index = result.indexOf('\n=====')
        result = result.slice(index, result.length)
        result = result.replace(/^IELE\s+assembly\s*\:\s*$/mgi, '')
        ieleCode = result.replace(/^=====/mg, '// =====')


      }
      cb()
    })
    .catch(()=> cb())
  }

  function formatIeleErrors(message, target) {
    if (isNaN('0x' + message)) {
      let start = 0
      let end = 0
      const lines = message.split('\n')
      return [{
        component: 'general',
        formattedMessage: message,
        severity: 'warning',
        type: 'Warning',
        message: message,
        sourceLocation: {
          start,
          end,
          file: target
        }
      }]
    } else {
      return undefined
    }
  }

  function compileIELE(sources, target) {
    console.log('@compileIELE', sources, target)
    const apiGateway = 'https://5c177bzo9e.execute-api.us-east-1.amazonaws.com/prod'
    const params = [target, {}]
    for (const filePath in sources) {
      params[1][filePath] = sources[filePath].content
    }
    window['fetch'](apiGateway, {
      method: 'POST',
      cors: true,
      body: JSON.stringify({
        method: 'iele_asm',
        params: params,
        jsonrpc: '2.0'
      })
    })
    .then(response=>response.json())
    .then(json => {
      if (json['error']) {
        const result = { error: json['error']['data'].toString() }
        console.log('@compilationFinished 1')
        compilationFinished(result, undefined, {sources, target})
      } else {
        const r = json['result']
        const contractNamesMatch = sources[target].content.match(/\s*contract\s+(.+?){\s*/ig) // the last contract is the main contract (from Dwight)
        let contractName = ""
        if (contractNamesMatch) {
          contractName = contractNamesMatch[contractNamesMatch.length - 1].trim().split(/\s+/)[1]
        }
        const bytecode = isNaN('0x' + r) ? '' : r
        const result = {
          contracts: {
            [target]: {
              [contractName]: {
                abi: [],
                devdoc: {
                  methods: {}
                },
                metadata: {
                  compiler: 'sol2iele'
                },
                ielevm: {
                  bytecode: {
                    object: bytecode
                  },
                  gasEstimate: {
                    codeDepositCost: '0',
                    executionCost: '0',
                    totalCost: '0'
                  }
                },
              }
            }
          },
          errors: formatIeleErrors(r, target),
          sources
        }
        console.log('@compileIELE .iele => result:\n', result)
        console.log('@compilationFinished 2')
        compilationFinished(result, undefined, {sources, target})
        console.log('@done compilationFinished 2')
      }
    })
    .catch((error)=> {
      console.log('@compilationFinished 3')
      compilationFinished({ error: error.toString(), }, undefined, {sources, target})
    })
  }

  function onInternalCompilerLoaded () {
    if (worker === null) {
      var compiler
      if (typeof (window) === 'undefined') {
        compiler = require('solc')
      } else {
        compiler = solc(window.Module)
      }

      compileJSON = function (source, optimize, cb) {
        var missingInputs = []
        var missingInputsCallback = function (path) {
          missingInputs.push(path)
          return { error: 'Deferred import' }
        }

        var result
        try {
          var input = compilerInput(source.sources, {optimize: optimize, target: source.target})
          result = compiler.compileStandardWrapper(input, missingInputsCallback)
          result = JSON.parse(result)
          /*
          if (compileToIELE) {
            return compileSolidityToIELE(result, source, ()=> {
              compilationFinished(result, missingInputs, source)
            })
          }
          */
         console.log('@compileJSON .sol => result:\n', result)
        } catch (exception) {
          result = { error: 'Uncaught JavaScript exception:\n' + exception }
        }

        console.log('@compilationFinished 5')
        compilationFinished(result, missingInputs, source)
      }
      onCompilerLoaded(compiler.version())
    }
  }
  // exposed for use in node
  this.onInternalCompilerLoaded = onInternalCompilerLoaded

  this.lastCompilationResult = {
    data: null,
    source: null
  }

  /**
    * return the contract obj of the given @arg name. Uses last compilation result.
    * return null if not found
    * @param {String} name    - contract name
    * @returns contract obj and associated file: { contract, file } or null
    */
  this.getContract = (name) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return txHelper.getContract(name, this.lastCompilationResult.data.contracts)
    }
    return null
  }

  /**
    * call the given @arg cb (function) for all the contracts. Uses last compilation result
    * @param {Function} cb    - callback
    */
  this.visitContracts = (cb) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return txHelper.visitContracts(this.lastCompilationResult.data.contracts, cb)
    }
    return null
  }

  /**
    * return the compiled contracts from the last compilation result
    * @return {Object}     - contracts
    */
  this.getContracts = () => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return this.lastCompilationResult.data.contracts
    }
    return null
  }

   /**
    * return the sources from the last compilation result
    * @param {Object} cb    - map of sources
    */
  this.getSources = () => {
    if (this.lastCompilationResult.source) {
      return this.lastCompilationResult.source.sources
    }
    return null
  }

  /**
    * return the sources @arg fileName from the last compilation result
    * @param {Object} cb    - map of sources
    */
  this.getSource = (fileName) => {
    if (this.lastCompilationResult.source) {
      return this.lastCompilationResult.source.sources[fileName]
    }
    return null
  }

  /**
    * return the source from the last compilation result that has the given index. null if source not found
    * @param {Int} index    - index of the source
    */
  this.getSourceName = (index) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.sources) {
      return Object.keys(this.lastCompilationResult.data.sources)[index]
    }
    return null
  }

  function compilationFinished (data, missingInputs, source) {
    console.log("@compiler.js compilationFinished", data, missingInputs, source)
    var noFatalErrors = true // ie warnings are ok

    function isValidError (error) {
      // The deferred import is not a real error
      // FIXME: maybe have a better check?
      if (/Deferred import/.exec(error.message)) {
        return false
      }

      return error.severity !== 'warning'
    }

    if (data['error'] !== undefined) {
      // Ignore warnings (and the 'Deferred import' error as those are generated by us as a workaround
      if (isValidError(data['error'])) {
        noFatalErrors = false
      }
    }
    if (data['errors'] !== undefined) {
      data['errors'].forEach(function (err) {
        // Ignore warnings and the 'Deferred import' error as those are generated by us as a workaround
        if (isValidError(err)) {
          noFatalErrors = false
        }
      })
    }

    if (!noFatalErrors) {
      console.log('@ There is fatal errors');
      // There are fatal errors - abort here
      self.lastCompilationResult = null
      self.event.trigger('compilationFinished', [false, data, source])
    } else if (missingInputs !== undefined && missingInputs.length > 0) {
      // try compiling again with the new set of inputs
      internalCompile(source.sources, source.target, missingInputs)
    } else {
      if (source.target.endsWith('.sol')) {
        data = updateInterface(data)
      }
      console.log('@@ success')
      self.lastCompilationResult = {
        data: data,
        source: source
      }
      console.log('@@ start triggering event')
      self.event.trigger('compilationFinished', [true, data, source])
      console.log('@@ done trigger event')
    }
  }

  // TODO: needs to be changed to be more node friendly
  this.loadVersion = function (usingWorker, url) {
    console.log('Loading ' + url + ' ' + (usingWorker ? 'with worker' : 'without worker'))
    self.event.trigger('loadingCompiler', [url, usingWorker])

    if (usingWorker) {
      loadWorker(url)
    } else {
      loadInternal(url)
    }
  }

  function loadInternal (url) {
    delete window.Module
    // NOTE: workaround some browsers?
    window.Module = undefined

    // Set a safe fallback until the new one is loaded
    setCompileJSON(function (source, optimize) {
      console.log('@compilationFinished 6')
      compilationFinished({ error: { formattedMessage: 'Compiler not yet loaded.' } })
    })

    var newScript = document.createElement('script')
    newScript.type = 'text/javascript'
    newScript.src = url
    document.getElementsByTagName('head')[0].appendChild(newScript)
    var check = window.setInterval(function () {
      if (!window.Module) {
        return
      }
      window.clearInterval(check)
      onInternalCompilerLoaded()
    }, 200)
  }

  function loadWorker (url) {
    if (worker !== null) {
      worker.terminate()
    }
    worker = webworkify(require('./compiler-worker.js'))
    var jobs = []
    worker.addEventListener('message', function (msg) {
      var data = msg.data
      switch (data.cmd) {
        case 'versionLoaded':
          onCompilerLoaded(data.data)
          break
        case 'compiled':
          var result
          try {
            result = JSON.parse(data.data)
          } catch (exception) {
            result = { 'error': 'Invalid JSON output from the compiler: ' + exception }
          }
          var sources = {}
          if (data.job in jobs !== undefined) {
            sources = jobs[data.job].sources
            delete jobs[data.job]
          }
          console.log('@compilationFinished 7')
          compilationFinished(result, data.missingInputs, sources)
          break
      }
    })
    worker.onerror = function (msg) {
      console.log('@compilationFinished 8')
      compilationFinished({ error: 'Worker error: ' + msg.data })
    }
    worker.addEventListener('error', function (msg) {
      console.log('@compilationFinished 9')
      compilationFinished({ error: 'Worker error: ' + msg.data })
    })
    compileJSON = function (source, optimize) {
      jobs.push({sources: source})
      worker.postMessage({cmd: 'compile', job: jobs.length - 1, input: compilerInput(source.sources, {optimize: optimize, target: source.target})})
    }
    worker.postMessage({cmd: 'loadVersion', data: url})
  }

  function gatherImports (files, target, importHints, cb) {
    importHints = importHints || []

    // FIXME: This will only match imports if the file begins with one.
    //        It should tokenize by lines and check each.
    // eslint-disable-next-line no-useless-escape
    var importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g

    for (var fileName in files) {
      var match
      while ((match = importRegex.exec(files[fileName].content))) {
        var importFilePath = match[1]
        if (importFilePath.startsWith('./')) {
          var path = /(.*\/).*/.exec(target)
          if (path !== null) {
            importFilePath = importFilePath.replace('./', path[1])
          } else {
            importFilePath = importFilePath.slice(2)
          }
        }

        // FIXME: should be using includes or sets, but there's also browser compatibility..
        if (importHints.indexOf(importFilePath) === -1) {
          importHints.push(importFilePath)
        }
      }
    }

    while (importHints.length > 0) {
      var m = importHints.pop()
      if (m in files) {
        continue
      }

      if (handleImportCall) {
        handleImportCall(m, function (err, content) {
          if (err) {
            cb(err)
          } else {
            files[m] = { content }
            gatherImports(files, target, importHints, cb)
          }
        })
      }

      return
    }

    cb(null, { 'sources': files, 'target': target })
  }

  function truncateVersion (version) {
    var tmp = /^(\d+.\d+.\d+)/.exec(version)
    if (tmp) {
      return tmp[1]
    }
    return version
  }

  function updateInterface (data) {
    txHelper.visitContracts(data.contracts, (contract) => {
      console.log('@updateInterface => @visitContracts')
      data.contracts[contract.file][contract.name].abi = solcABI.update(truncateVersion(currentVersion), contract.object.abi)
    })
    return data
  }
}

module.exports = Compiler
