exports.parse = function parse(value) {
  return String(value).trim();
};
function wrapper(parse) { return parse("shadowed"); }
const comment = "parse in a string is not a symbol";
module.exports.wrapper = wrapper;
module.exports.comment = comment;
