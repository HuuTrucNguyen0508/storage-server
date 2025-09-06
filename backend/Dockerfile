# Use Node.js 18 Ubuntu as base image
FROM node:18-slim

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install

# Copy source code
COPY . .

# Build the Next.js application
RUN pnpm build

# Create uploads directory
RUN mkdir -p uploads database

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]
