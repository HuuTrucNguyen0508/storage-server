FROM node:26-slim AS frontend
RUN node --input-type=module -e 'import {writeFileSync,mkdirSync,symlinkSync} from "node:fs"; import {createHash} from "node:crypto"; import {execFileSync} from "node:child_process"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw new Error(r.statusText); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("base64")!=="SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==") throw new Error("corepack checksum"); writeFileSync("/corepack.tgz",b); mkdirSync("/usr/local/lib/node_modules/corepack",{recursive:true}); execFileSync("tar",["xzf","/corepack.tgz","--strip-components=1","-C","/usr/local/lib/node_modules/corepack"]); symlinkSync("/usr/local/lib/node_modules/corepack/dist/corepack.js","/usr/local/bin/corepack");' \
    && corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
COPY docs/design/ui/tokens.css /src/docs/design/ui/tokens.css
RUN pnpm build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /storage-server ./cmd/storage-server

FROM scratch
COPY --from=build /storage-server /storage-server
USER 1000:1000
EXPOSE 8080 8081 9090
HEALTHCHECK --interval=30s --timeout=5s CMD ["/storage-server", "healthcheck"]
ENTRYPOINT ["/storage-server"]
