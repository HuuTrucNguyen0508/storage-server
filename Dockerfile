FROM golang:1.27 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /storage-server ./cmd/storage-server

FROM scratch
COPY --from=build /storage-server /storage-server
EXPOSE 8080 8081 9090
ENTRYPOINT ["/storage-server"]
