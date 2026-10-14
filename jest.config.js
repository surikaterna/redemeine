/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/.cache/'],
  moduleNameMapper: {
    '^@redemeine/(.+)$': '<rootDir>/packages/$1/src'
  }
};
