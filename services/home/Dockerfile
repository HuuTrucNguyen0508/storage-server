# Home portal: static files from services/home/site served by unprivileged nginx.
# Build from the repo root: docker build -f services/home/Dockerfile -t lab/home:<tag> .
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.7-alpine3.24@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

FROM ${NGINX_IMAGE} AS csp
USER root
COPY services/home/site/ /site/
COPY services/home/deploy/nginx/ /conf/
# Hash every inline <script> so the CSP allows exactly those and nothing else.
RUN sh /conf/csp-hashes.sh

FROM ${NGINX_IMAGE}
COPY --from=csp /conf/nginx.conf /etc/nginx/nginx.conf
COPY --from=csp /conf/security-headers.rendered /etc/nginx/security-headers.conf
COPY --chown=root:root services/home/site/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
