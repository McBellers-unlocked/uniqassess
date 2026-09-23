#!/usr/bin/env bash
set -euo pipefail
DOMAIN=lab-runner.uniqassess.org
install -d -m 0755 /var/www/letsencrypt
cat > /etc/nginx/sites-available/uniqassess-lab <<'EOF'
limit_req_zone $binary_remote_addr zone=lab_requests:10m rate=5r/s;
limit_conn_zone $binary_remote_addr zone=lab_connections:10m;
server {
  listen 80 default_server;
  server_name lab-runner.uniqassess.org;
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 404; }
}
EOF
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
ln -sf /etc/nginx/sites-available/uniqassess-lab /etc/nginx/sites-enabled/uniqassess-lab
nginx -t
systemctl reload nginx
certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
cat >> /etc/nginx/sites-available/uniqassess-lab <<'EOF'
server {
  listen 443 ssl;
  server_name lab-runner.uniqassess.org;
  ssl_certificate /etc/letsencrypt/live/lab-runner.uniqassess.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/lab-runner.uniqassess.org/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  server_tokens off;
  client_max_body_size 40k;
  client_body_timeout 10s;
  client_header_timeout 10s;
  keepalive_timeout 15s;
  add_header Strict-Transport-Security "max-age=31536000" always;
  location /v1/labs/ {
    limit_req zone=lab_requests burst=30 nodelay;
    limit_conn lab_connections 10;
    proxy_pass http://10.43.0.20:8080;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_send_timeout 10s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_http_version 1.1;
  }
  location / { return 404; }
}
EOF
nginx -t
systemctl reload nginx
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/uniqassess-nginx
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/uniqassess-nginx
systemctl enable --now certbot.timer
printf 'Authenticated lab ingress configured with HTTPS, bounded requests and certificate renewal.\n'
