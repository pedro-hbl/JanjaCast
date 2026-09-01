# --- web client build ---
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Bake the Discord application id into the client bundle.
ARG GOLIVE_DISCORD_CLIENT_ID
ENV GOLIVE_DISCORD_CLIENT_ID=$GOLIVE_DISCORD_CLIENT_ID
RUN npm run build

# --- server build ---
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /golive ./cmd/golive

# --- runtime ---
FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=server /golive /golive
EXPOSE 8080
ENTRYPOINT ["/golive"]
