var remixLib = require('remix-lib')
var executionContext = remixLib.execution.executionContext

// @rv: hack to override some functions
executionContext.detectNetwork = (function (callback) {
  if (this.isVM()) {
    callback(null, { id: '-', name: 'VM' })
  } else if (this.getProvider() === 'kevm-testnet') {
    callback(null, { id: '-', name: "KEVM Testnet" })
  } else {
    this.web3().version.getNetwork((err, id) => {
      var name = null
      if (err) name = 'Unknown'
      // https://github.com/ethereum/EIPs/blob/master/EIPS/eip-155.md
      else if (id === '1') name = 'Main'
      else if (id === '2') name = 'Morden (deprecated)'
      else if (id === '3') name = 'Ropsten'
      else if (id === '4') name = 'Rinkeby'
      else if (id === '42') name = 'Kovan'
      else if (id === '13137357') name = 'Goguen'
      else name = 'Custom'

      if (id === '1') {
        this.web3().eth.getBlock(0, (error, block) => {
          if (error) console.log('cant query first block')
          if (block && block.hash !== mainNetGenesisHash) name = 'Custom'
          callback(err, { id, name })
        })
      } else {
        callback(err, { id, name })
      }
    })
  }
}).bind(executionContext)

/*
// @rv: hack `executionContext` variable
var _executionContext = null
var _oldGetProvider = executionContext.getProvider
executionContext.getProvider = (function() {
  return _executionContext || _oldGetProvider()
}).bind(executionContext)

// @rv: hack to override some functions
executionContext.executionContextChange = (function (context, endPointUrl, confirmCb, infoCb, cb, rvCb) {
  console.log('@executionContextChange', context)
  if (!cb) cb = () => {}
  var self = this
  var vm = self.vm()
  var web3 = this.web3()
  var injectedProvider = web3 ? this.web3().currentProvider : undefined
  console.log('injectedProvider: ', injectedProvider)

  if (context === 'vm') {
    _executionContext = context
    vm.stateManager.revert(function () {
      vm.stateManager.checkpoint()
    })
    self.event.trigger('contextChanged', ['vm'])
    return cb()
  }

  if (context === 'injected') {
    if (injectedProvider === undefined) {
      var alertMsg = 'No injected Web3 provider found. '
      alertMsg += 'Make sure your provider (e.g. MetaMask) is active and running '
      alertMsg += '(when recently activated you may have to reload the page).'
      infoCb(alertMsg)
      return cb()
    } else {
      _executionContext = context
      web3.setProvider(injectedProvider)
      self._updateBlockGasLimit()
      self.event.trigger('contextChanged', ['injected'])
      return cb()
    }
  }

  if (context === 'web3') {
    confirmCb(cb)
  }

  if (context === 'kevm-testnet') {
    _executionContext = context
    self.event.trigger('contextChanged', ['kevm-testnet'])
    self.web3().setProvider('https://kevm-testnet.iohkdev.io:8546')
    rvCb(context)
  }

}).bind(executionContext)
*/

module.exports = executionContext
