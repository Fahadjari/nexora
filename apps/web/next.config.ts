import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Fail the production build on a type error rather than shipping it. The
  // default is to fail too, but people disable it under deadline pressure and
  // then discover the bug in production — so it is pinned here deliberately.
  typescript: { ignoreBuildErrors: false },
};

export default config;
