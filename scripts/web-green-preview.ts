// Screenshot and browser entry for the isolated fixture frontend. The normal
// preview server owns all shared run, unit, cost and delivery transports.
if (!process.argv.includes("--green")) process.argv.push("--green");
await import("./web-preview.js");
export {};
