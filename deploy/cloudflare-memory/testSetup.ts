// Routine Worker logs are not test output. With console interception disabled
// they would flood the runner; keep warnings and errors visible, while tests
// that need a logger inject or spy on one explicitly.
console.log = () => {};
console.info = () => {};
console.debug = () => {};
