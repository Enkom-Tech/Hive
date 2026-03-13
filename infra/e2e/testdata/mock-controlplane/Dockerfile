FROM golang:1.26.1-alpine AS build
WORKDIR /app
COPY go.mod .
COPY main.go .
RUN go build -o mock-controlplane .

FROM alpine:latest
COPY --from=build /app/mock-controlplane /mock-controlplane
EXPOSE 8080
ENTRYPOINT ["/mock-controlplane"]
