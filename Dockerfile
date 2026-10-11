FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY requirements.txt ./
RUN python3 -m venv .venv \
  && ./.venv/bin/python -m pip install --upgrade pip \
  && ./.venv/bin/python -m pip install -r requirements.txt

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PYTHON_BIN=/app/.venv/bin/python

CMD ["sh", "-c", "npm run start"]
