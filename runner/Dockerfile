FROM python:3.10-slim

WORKDIR /srv/clawbrain

COPY runner/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY runner /srv/clawbrain/runner
COPY shared /srv/clawbrain/shared

# Ensure policy linux_user lookups resolve in-container for worker identity checks.
RUN set -eux; \
    if ! getent group codex >/dev/null; then groupadd -g 1001 codex; fi; \
    if ! id -u codex >/dev/null 2>&1; then useradd -m -u 1001 -g 1001 codex; fi; \
    if ! getent group builder >/dev/null; then groupadd -g 1002 builder; fi; \
    if ! id -u builder >/dev/null 2>&1; then useradd -m -u 1002 -g 1002 builder; fi; \
    if ! getent group deployer >/dev/null; then groupadd -g 1003 deployer; fi; \
    if ! id -u deployer >/dev/null 2>&1; then useradd -m -u 1003 -g 1003 deployer; fi

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/srv/clawbrain

CMD ["python", "-m", "runner.worker", "--agent", "CoderAgent"]
