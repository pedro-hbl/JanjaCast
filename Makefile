.PHONY: all web server run dev clean

all: web server

web:
	cd web && npm install && npm run build

server:
	go build -o janjacast ./cmd/janjacast

run: all
	./janjacast

# Dev loop: vite dev server on :5173 proxying API/WS to the Go server on :8080.
dev:
	@echo "Run these in two terminals:"
	@echo "  go run ./cmd/janjacast"
	@echo "  cd web && npm run dev"

clean:
	rm -f janjacast janjacast.exe
	rm -rf web/dist web/node_modules
