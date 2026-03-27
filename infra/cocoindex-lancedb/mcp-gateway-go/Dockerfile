FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mcp-gateway /mcp-gateway
USER nonroot:nonroot
EXPOSE 9090
ENV LISTEN_ADDR=:9090
ENTRYPOINT ["/mcp-gateway"]
