FROM golang:1.26.1-alpine AS builder
WORKDIR /workspace
COPY go.mod go.sum ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o hive-worker ./cmd/worker

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=builder /workspace/hive-worker /usr/local/bin/hive-worker
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/hive-worker"]
