FROM python:3.10-slim

WORKDIR /srv/clawbrain

COPY api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY api /srv/clawbrain/api
COPY runner /srv/clawbrain/runner
COPY shared /srv/clawbrain/shared
COPY scripts /srv/clawbrain/scripts

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/srv/clawbrain

EXPOSE 8000

CMD ["uvicorn", "api.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
