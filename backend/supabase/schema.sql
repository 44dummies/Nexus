create extension if not exists "pgcrypto";

create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    created_at timestamptz default now()
);

create table if not exists accounts (
    id uuid primary key default gen_random_uuid(),
    deriv_account_id text not null unique,
    account_type text not null check (account_type in ('real', 'demo')),
    currency text,
    created_at timestamptz default now()
);

create table if not exists sessions (
    id uuid primary key default gen_random_uuid(),
    account_id text not null,
    account_type text not null check (account_type in ('real', 'demo')),
    currency text,
    token_encrypted jsonb,
    last_seen timestamptz default now(),
    created_at timestamptz default now()
);

create unique index if not exists idx_sessions_account_unique on sessions (account_id);

create table if not exists bots (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique,
    name text not null,
    risk_profile text,
    config jsonb,
    created_at timestamptz default now()
);

create table if not exists bot_runs (
    id uuid primary key default gen_random_uuid(),
    account_id text not null,
    bot_id text,
    run_status text not null default 'running',
    started_at timestamptz default now(),
    stopped_at timestamptz,
    config jsonb,
    backend_mode boolean default false,
    created_at timestamptz default now()
);

create table if not exists trades (
    id uuid primary key default gen_random_uuid(),
    account_id text,
    account_type text,
    bot_id text,
    bot_run_id uuid,
    entry_profile_id text,
    contract_id bigint,
    symbol text,
    stake numeric,
    duration integer,
    duration_unit text,
    profit numeric,
    buy_price numeric,
    payout numeric,
    direction text,
    status text,
    created_at timestamptz default now()
);

create table if not exists order_status (
    id uuid primary key default gen_random_uuid(),
    account_id text,
    trade_id uuid,
    contract_id bigint,
    event text not null,
    status text,
    price numeric,
    latency_ms integer,
    payload jsonb,
    created_at timestamptz default now()
);

create table if not exists notifications (
    id uuid primary key default gen_random_uuid(),
    account_id text,
    title text not null,
    body text not null,
    type text,
    data jsonb,
    created_at timestamptz default now(),
    read_at timestamptz
);

create table if not exists risk_events (
    id uuid primary key default gen_random_uuid(),
    account_id text,
    event_type text not null,
    detail text,
    metadata jsonb,
    created_at timestamptz default now()
);

create table if not exists settings (
    id uuid primary key default gen_random_uuid(),
    account_id text not null,
    key text not null,
    value jsonb,
    updated_at timestamptz default now(),
    unique (account_id, key)
);

create index if not exists idx_accounts_deriv_id on accounts (deriv_account_id);
create index if not exists idx_sessions_account_id on sessions (account_id);
create index if not exists idx_bot_runs_account_id on bot_runs (account_id);
create index if not exists idx_trades_account_id on trades (account_id);
create index if not exists idx_trades_contract_id on trades (contract_id);
create index if not exists idx_order_status_account_id on order_status (account_id);
create index if not exists idx_order_status_contract_id on order_status (contract_id);
create index if not exists idx_notifications_account_id on notifications (account_id);
create index if not exists idx_risk_events_account_id on risk_events (account_id);
