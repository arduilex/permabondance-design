FROM docker:27-cli

# git pour surveiller le dépôt + plugin "docker compose"
RUN apk add --no-cache git docker-cli-compose

COPY deploy.sh /usr/local/bin/deploy.sh
RUN chmod +x /usr/local/bin/deploy.sh

ENTRYPOINT ["/usr/local/bin/deploy.sh"]
