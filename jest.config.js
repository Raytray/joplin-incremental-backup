'use strict';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    // Redirect Joplin's runtime-injected 'api' module to the local mock
    '^api$': '<rootDir>/src/__mocks__/joplin.ts',
    '^api/types$': '<rootDir>/src/__mocks__/joplin.ts',
  },
  // Coverage collection excludes mocks and the thin entry point
  collectCoverageFrom: ['src/**/*.ts', '!src/__mocks__/**', '!src/index.ts'],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  },
};
