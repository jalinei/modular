module.exports = function defaultColor(idx) {
  return `hsl(${(idx * 60) % 360}, 70%, 50%)`;
};
