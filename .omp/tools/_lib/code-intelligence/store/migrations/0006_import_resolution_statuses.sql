ALTER TABLE code_imports
  DROP CONSTRAINT IF EXISTS code_imports_resolution_status_check;

ALTER TABLE code_imports
  ADD CONSTRAINT code_imports_resolution_status_check CHECK (
    resolution_status IN (
      'resolved_in_packet',
      'resolved_not_embedded',
      'resolved',
      'resolved_not_included',
      'external_package',
      'builtin',
      'ts_js_extension_remap',
      'missing_source',
      'missing_asset',
      'missing_generated',
      'missing_prompt_template',
      'missing_route_target',
      'unresolved'
    )
  );
