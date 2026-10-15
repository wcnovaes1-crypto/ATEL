// Run compiled tests: the legacy ts-jest 26 does not support TypeScript 5.4.
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/dist/__tests__/cloudWebhook.spec.js", "**/dist/__tests__/cloudApi.spec.js"],
  clearMocks: true
};
