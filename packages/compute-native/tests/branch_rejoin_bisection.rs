//! Branch-Rejoin Shape Bisection.
//!
//! The coverage lattice shows branch_rejoin passes at SMALL (k=4, n=1)
//! but fails at MEDIUM (k=128, n=128) and LARGE (k=1024, n=1024).
//! This test finds the exact (k,n) transition point.
//!
//! Modes:
//!   A: Vary k with fixed n=1
//!   B: Vary n with fixed k=4
//!   C: Vary both together (default)

use tribunus_compute_native::decode_attribution::shape_profiles::ShapeProfile;
use tribunus_compute_native::decode_attribution::graph_catalog;
use tribunus_compute_native::decode_attribution::backend_adapters::coreml_adapter;

fn run_mode(shapes: &[(u32, u32)], mode_name: &str) -> Vec<(u32, u32, bool, String)> {
    let mut results = Vec::new();
    let tmp = tempfile::tempdir().expect("tempdir");
    let output_dir = tmp.path();

    // Find the branch_rejoin family from the catalog
    let families = graph_catalog::all_families();
    let family = families.iter().find(|f| f.name == "branch_rejoin")
        .expect("branch_rejoin family not found in catalog");

    eprintln!("Bisection Mode {}:", mode_name);
    for &(k, n) in shapes {
        // Reuse the "small" name since name is only used for display/tracking.
        let profile_name: &'static str = Box::leak(format!("k{}n{}", k, n).into_boxed_str());
        let profile = ShapeProfile {
            name: &profile_name,
            input_rows: 1,
            input_cols: k,
            weight_rows: k,
            weight_cols: n,
        };

        match coreml_adapter::prepare(family, &profile, "cpuOnly", output_dir) {
            Ok(prepared) => {
                eprintln!("  k={:>4} n={:>4} -> PASS ({}ns)", k, n, prepared.prepare_duration_ns);
                results.push((k, n, true, String::new()));
            }
            Err(e) => {
                let msg = format!("{}", e);
                let truncated = if msg.len() > 100 { format!("{}...", &msg[..100]) } else { msg.clone() };
                eprintln!("  k={:>4} n={:>4} -> FAIL: {}", k, n, truncated);
                results.push((k, n, false, msg));
            }
        }
    }
    results
}

#[test]
fn bisection_mode_c() {
    let shapes: Vec<(u32, u32)> = vec![
        (8, 8), (16, 16), (32, 32), (48, 48), (64, 64),
        (96, 96), (128, 128),
    ];
    let results = run_mode(&shapes, "C (k=n)");

    let fail_point = results.iter().find(|&&(_, _, pass, _)| !pass).map(|&(k, n, _, _)| (k, n));
    if let Some((fail_k, fail_n)) = fail_point {
        eprintln!("  => Breakpoint at k={}, n={}", fail_k, fail_n);

        // Discriminator probes around breakpoint
        eprintln!("  => Mode A discriminator (k={}, n=1):", fail_k);
        let pa = run_mode(&[(fail_k, 1)], "A-probe");
        for &(k, _n, pass, ref err) in &pa {
            eprintln!("     k={} n=1 -> {}: {}", k, if pass { "PASS" } else { "FAIL" },
                if pass { "issue is not k-solo" } else { &err[..err.len().min(80)] });
        }

        eprintln!("  => Mode B discriminator (k=4, n={}):", fail_n);
        let pb = run_mode(&[(4, fail_n)], "B-probe");
        for &(_k, n, pass, ref err) in &pb {
            eprintln!("     k=4 n={} -> {}: {}", n, if pass { "PASS" } else { "FAIL" },
                if pass { "issue is not n-solo" } else { &err[..err.len().min(80)] });
        }
    } else {
        eprintln!("  => No failure found up to k=128 — all shapes pass");
    }
}

#[test]
fn bisection_mode_a() {
    let shapes: Vec<(u32, u32)> = vec![8, 16, 32, 48, 64, 80, 96, 112, 128]
        .into_iter().map(|k| (k, 1)).collect();
    run_mode(&shapes, "A (k varies, n=1)");
}

#[test]
fn bisection_mode_b() {
    let shapes: Vec<(u32, u32)> = vec![2, 4, 8, 16, 32, 64, 128, 256]
        .into_iter().map(|n| (4, n)).collect();
    run_mode(&shapes, "B (k=4, n varies)");
}
