# Use official Nginx Alpine image as base
FROM nginx:alpine

# Set maintainer information
LABEL maintainer="File Storage System"
LABEL description="Custom Nginx configuration for file storage system"

# Install additional packages if needed
RUN apk add --no-cache \
    curl \
    && rm -rf /var/cache/apk/*

# Create necessary directories
RUN mkdir -p /var/log/nginx \
    && mkdir -p /var/cache/nginx \
    && mkdir -p /etc/nginx/conf.d

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Set proper permissions
RUN chown -R nginx:nginx /var/log/nginx \
    && chown -R nginx:nginx /var/cache/nginx \
    && chmod -R 755 /var/log/nginx \
    && chmod -R 755 /var/cache/nginx

# Create a health check script
RUN echo '#!/bin/sh' > /usr/local/bin/healthcheck.sh \
    && echo 'curl -f http://localhost/health || exit 1' >> /usr/local/bin/healthcheck.sh \
    && chmod +x /usr/local/bin/healthcheck.sh

# Expose port 80
EXPOSE 80

# Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD /usr/local/bin/healthcheck.sh

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
