# The thin forwarder of the old address (story 4796): the pinned Caddy of the stack plus one Caddyfile. Built by Cloud Build in the
# project's own registry (Cloud Run does not pull from Docker Hub), see CUTOVER-prod.md step 4c.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
