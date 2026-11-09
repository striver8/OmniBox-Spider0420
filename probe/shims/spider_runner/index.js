"use strict";
const OmniBox = require("omnibox_sdk");
let captured = null;
const runner = {
  run(handlers) { captured = handlers; try { global.__SPIDER_HANDLERS = handlers; } catch (_) {} return handlers; },
  getHandlers() { return captured; },
  OmniBox,
};
module.exports = runner;
module.exports.default = runner;
module.exports.OmniBox = OmniBox;
