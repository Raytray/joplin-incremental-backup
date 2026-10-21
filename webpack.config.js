'use strict';

const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/index.ts',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'publish'),
    filename: 'index.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            // Use the build-specific tsconfig which excludes mocks and tests
            configFile: 'tsconfig.build.json',
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  // The 'api' module is provided by Joplin at runtime as the global `joplin`;
  // do not bundle it. 'api/types' is type-only and must not be required at
  // runtime, so it is not externalized here.
  externals: {
    api: 'var joplin',
  },
};
