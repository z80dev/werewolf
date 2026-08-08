# LemonSim AI-vs-AI werewolf stream runner.
# Elixir/OTP match /home/z80/dev/lemon/.tool-versions (elixir 1.19.5-otp-28, erlang 28.5).
FROM hexpm/elixir:1.19.5-erlang-28.5.0.5-debian-bookworm-20260803-slim

# jq: run_loop.sh builds games.json; git: mix deps may need it; build-essential: NIF deps.
RUN apt-get update && \
    apt-get install -y --no-install-recommends jq git ca-certificates build-essential && \
    rm -rf /var/lib/apt/lists/*

ENV MIX_ENV=prod

WORKDIR /app

COPY lemon/ /app/
COPY config.toml /root/.lemon/config.toml

RUN mix deps.get && mix compile

COPY run_loop.sh /usr/local/bin/run_loop.sh
RUN chmod +x /usr/local/bin/run_loop.sh

CMD ["/usr/local/bin/run_loop.sh"]
