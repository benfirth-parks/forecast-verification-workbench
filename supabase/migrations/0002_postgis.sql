-- PostGIS geometry alongside the GeoJSON columns from 0001. Requires the
-- postgis extension (enabled on Supabase under Database → Extensions).
-- Geometry columns are derived from the stored GeoJSON so the original
-- source geometry is never rewritten.
create extension if not exists postgis with schema extensions;

alter table public.forecast_domains
  add column geometry extensions.geography(MultiPolygon, 4326)
  generated always as (case when geometry_geojson is null then null
    else extensions.ST_Multi(extensions.ST_GeomFromGeoJSON(geometry_geojson::text))::extensions.geography end) stored;

alter table public.avalanche_events
  add column geometry extensions.geography(Geometry, 4326)
  generated always as (case when geometry_geojson is null then null
    else extensions.ST_GeomFromGeoJSON(geometry_geojson::text)::extensions.geography end) stored;

alter table public.field_observations
  add column geometry extensions.geography(Geometry, 4326)
  generated always as (case when geometry_geojson is null then null
    else extensions.ST_GeomFromGeoJSON(geometry_geojson::text)::extensions.geography end) stored;

create index on public.forecast_domains using gist (geometry);
create index on public.avalanche_events using gist (geometry);
create index on public.field_observations using gist (geometry);
