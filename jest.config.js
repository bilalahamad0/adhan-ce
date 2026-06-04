export default {
  // Default environment is Node (service worker + pure libs). The DOM suites
  // (content/popup) opt into jsdom via a per-file `@jest-environment` docblock.
  testEnvironment: 'node',
  transform: {},
  coverageDirectory: 'coverage',
  // Measure the whole shipped extension, not just lib/. Build/tooling scripts,
  // generated icons and the locale JSON are excluded — they're verified by the
  // manifest/locale integrity suites rather than executed under coverage.
  collectCoverageFrom: ['lib/**/*.js', 'background.js', 'content.js', 'popup.js'],
  // Locks in the current ~96% statement / ~98% line coverage with a little headroom
  // so an unintended drop fails CI, while normal refactors don't trip on noise.
  coverageThreshold: {
    global: { statements: 92, branches: 74, functions: 85, lines: 95 },
  },
};
