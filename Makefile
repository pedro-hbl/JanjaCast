.PHONY: all web server run dev clean

all: web server

web:
	cd web && npm install && npm run build

server:
	go build -o golive ./cmd/golive

run: all
	./golive

# Dev loop: vite dev server on :5173 proxying API/WS to the Go server on :8080.
dev:
	@echo "Run these in two terminals:"
	@echo "  go run ./cmd/golive"
	@echo "  cd web && npm run dev"

clean:
	rm -f golive golive.exe
	rm -rf web/dist web/node_modules
