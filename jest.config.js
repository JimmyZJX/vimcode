/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  resolver: "ts-jest-resolver",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  globals: {
    transform: {
      "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    },
  },
};
