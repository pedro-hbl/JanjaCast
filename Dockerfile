# --- web client build ---
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# No client id is baked in: the server provides it at runtime via
# /api/config, so one image works for any Discord application.
RUN npm run build

# --- server build ---
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /janjacast ./cmd/janjacast

# --- runtime ---
FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=server /janjacast /janjacast
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/janjacast"]
