.PHONY: up dev down env logs ps

## Generate .env from .env.example with random secrets (skips if .env exists)
env:
	python3 scripts/init-env.py

## Start all services (auto-generates .env if missing)
up: env
	docker compose up -d

## Start all services in foreground (auto-generates .env if missing)
dev: env
	docker compose up

## Stop all services
down:
	docker compose down

## Show service logs
logs:
	docker compose logs -f

## Show running containers
ps:
	docker compose ps
