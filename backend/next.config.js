/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
  },
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
    responseLimit: false, // Disable response size limit
  },
  images: {
    domains: ['localhost'],
  },
}

module.exports = nextConfig
