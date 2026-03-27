# Minimal OpenAI-compatible model router (stdlib Go). Prefer over infra/model-gateway Python for smaller CVE surface.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/model-gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/model-gateway /model-gateway
USER nonroot:nonroot
EXPOSE 8080
ENV CONFIG_PATH=/etc/model-gateway/models.json
ENTRYPOINT ["/model-gateway"]
