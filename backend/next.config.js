/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
  },
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
  images: {
    domains: ['localhost'],
  },
}

module.exports = nextConfig
