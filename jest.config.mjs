export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["**/src/__tests__/**/*.test.ts"],
  globals: {
    "ts-jest": {
      useESM: true,
    },
  },
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  injectGlobals: true,
};
