/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // rewrites() is silently ignored by `next build` with output: 'export',
  // but still works in `next dev` for local API proxying.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
