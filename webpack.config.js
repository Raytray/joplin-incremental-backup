'use strict';

const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/index.ts',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'publish'),
    filename: 'index.js',
    library: {
      type: 'commonjs2',
    },
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
  // The 'api' module is provided by Joplin at runtime; do not bundle it.
  externals: {
    api: 'api',
    'api/types': 'api/types',
  },
};
