var analytics = require('analytics');
var config = require('config');
var debug = require('debug');
var fmt = require('fmt');
var request = require('request');

/**
 * Format Errors
 */

fmt.e = function(e) {
  var s = e.toString() + '\n';
  s += e.fileName || '';
  s += e.lineNumber ? ':' + e.lineNumber : '';
  s += e.columnNumber ? ':' + e.columnNumber : '';
  s += e.stack ? '\n' + e.stack : '';
  return s;
};

/**
 * Logging levels
 */

var levels = ['silly', 'debug', 'verbose', 'info', 'warn', 'error'];
var infoIndex = levels.indexOf('info');

/**
 * Expose `log`
 */

module.exports = function(name) {
  var _debug = debug(config.application() + ':' + name);

  function _log(type, text) {
    if (levels.indexOf(type) === -1) {
      text = fmt.apply(null, arguments);
      type = 'verbose';
    }

    // Send to console
    _debug(text);

    // Save info & above
    if (levels.indexOf(type) >= infoIndex) {
      // Send to analytics
      analytics.track('log:' + type, {
        text: text,
        type: type
      });

      // Send to server
      request.post('/log', {
        text: text,
        type: type
      });
    }
  }

  levels.forEach(function(level) {
    _log[level] = function() {
      _log(level, fmt.apply(null, arguments));
    };
  });

  return _log;
};
