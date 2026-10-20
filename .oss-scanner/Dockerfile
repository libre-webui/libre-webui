# syntax=docker/dockerfile:1
#
# Build environment for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as context, then audits the image with no
# network, reading threat_model.md next to this file. Everything the build, the tests and
# a reproducer need has to be fetched here.
#
# It builds Libre WebUI the way CI does: one npm workspace (root, frontend/, backend/) on
# Node 22.22, then the Vite frontend and the TypeScript backend. CI runs the package tests
# against PostgreSQL with pgvector, Redis and MinIO in their own containers. This image has
# all three installed instead:
#
#   libre-services start              PostgreSQL :5432, Redis :6379, MinIO :9000
#   . /etc/libre-scanner/test.env     the environment CI runs the package tests in
#   node --test scripts/test-authorization.mjs
#
# Most scripts/test-*.mjs files run without the services; the Postgres, Redis and S3
# suites skip themselves unless the TEST_* variables are set.
#
# If the build or the test setup changes, update this file in the same commit.

FROM node:22.22-trixie-slim AS node

# The MinIO server CI uses, pinned to the same digest. MinIO stopped publishing
# standalone binaries, so it comes out of the image.
FROM cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1 AS minio

FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HUSKY=0 \
    NODE_ENV=development \
    PGDATA=/var/lib/libre-services/postgres \
    PATH=/usr/lib/postgresql/17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Toolchain for the native modules (better-sqlite3, sharp), git for the postinstall hook,
# and the services the package tests talk to. pgvector comes from Debian, which ships it
# for PostgreSQL 17.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         build-essential ca-certificates curl git jq procps python3 sqlite3 \
         libsqlite3-dev libssl-dev libffi-dev \
         postgresql-17 postgresql-17-pgvector redis-server \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

COPY --from=minio /usr/bin/minio /usr/local/bin/minio
RUN minio --version

# The checkout lives at /src. The postinstall hook wants a git repository, which the
# build context may not carry.
COPY . /src
WORKDIR /src
RUN if [ ! -d .git ]; then \
      git init -q && git config user.email scanner@localhost && git config user.name scanner; \
    fi

RUN npm ci --no-audit --no-fund

# Frontend (Vite, which also builds the artifact sandbox runtime) and backend (tsc).
RUN npm run build

COPY --chmod=0755 <<'EOF' /usr/local/bin/libre-services
#!/bin/sh
# Start or stop the services the package tests use, all bound to localhost.
set -e
state=/var/lib/libre-services
case "$1" in
  start)
    mkdir -p "$state/minio" "$state/log"
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$PGDATA" && chown -R postgres:postgres "$state"
      su postgres -c "initdb -D '$PGDATA' --auth=trust >/dev/null"
    fi
    chown -R postgres:postgres "$PGDATA"
    su postgres -c "pg_ctl -D '$PGDATA' -l '$state/log/postgres.log' -o '-c listen_addresses=127.0.0.1' -w start"
    su postgres -c "psql -q -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'libre') THEN CREATE ROLE libre LOGIN SUPERUSER PASSWORD 'libre-ci-password'; END IF; END \\\$\\\$;\""
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'libre_test'\"" | grep -q 1 \
      || su postgres -c "createdb -O libre libre_test"
    su postgres -c "psql -q -d libre_test -c 'CREATE EXTENSION IF NOT EXISTS vector'"
    redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --save '' \
      --logfile "$state/log/redis.log"
    MINIO_ROOT_USER=libreminio MINIO_ROOT_PASSWORD=libre-ci-minio-password \
      nohup minio server "$state/minio" --address 127.0.0.1:9000 --quiet \
      >"$state/log/minio.log" 2>&1 &
    for i in $(seq 1 30); do
      curl -fs http://127.0.0.1:9000/minio/health/live >/dev/null && break
      sleep 1
    done
    mkdir -p "$state/minio/libre-ci-storage"
    echo "PostgreSQL :5432, Redis :6379 and MinIO :9000 are up. Load /etc/libre-scanner/test.env."
    ;;
  stop)
    pkill -x minio || true
    redis-cli -p 6379 shutdown nosave 2>/dev/null || true
    su postgres -c "pg_ctl -D '$PGDATA' -m fast stop" 2>/dev/null || true
    ;;
  *)
    echo "usage: libre-services start|stop" >&2
    exit 2
    ;;
esac
EOF

# The environment the Format & Lint workflow gives `npm run test:package`. The keys
# and passwords are throwaway test values, the same ones CI uses.
COPY <<'EOF' /etc/libre-scanner/test.env
export TEST_POSTGRES_URL=postgresql://libre:libre-ci-password@127.0.0.1:5432/libre_test
export TEST_REDIS_URL=redis://127.0.0.1:6379/0
export TEST_S3_ENDPOINT=http://127.0.0.1:9000
export TEST_S3_BUCKET=libre-ci-storage
export TEST_S3_REGION=us-east-1
export TEST_S3_ACCESS_KEY_ID=libreminio
export TEST_S3_SECRET_ACCESS_KEY=libre-ci-minio-password
export TEST_STORAGE_ENCRYPTION_KEY=9191919191919191919191919191919191919191919191919191919191919191
export TEST_TEAM_PLATFORM=1
EOF

CMD ["/bin/bash"]
