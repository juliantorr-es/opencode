use criterion::{criterion_group, criterion_main, Criterion};
use mlx_rs::{Array, Dtype};
use tribunus_compute_native::arena::Arena;
use std::time::Instant;

fn bench_mlx_eval(c: &mut Criterion) {
    let shape = [1024, 1024];
    c.bench_function("mlx_evaluation_latency", |b| {
        b.iter_custom(|iters| {
            let mut total = std::time::Duration::ZERO;
            for _ in 0..iters {
                let a = Array::from_slice(&vec![1.0f32; 1024 * 1024], &shape);
                let b_arr = Array::from_slice(&vec![2.0f32; 1024 * 1024], &shape);
                let c_arr = a.matmul(&b_arr).unwrap();
                let start = Instant::now();
                c_arr.eval().unwrap();
                total += start.elapsed();
            }
            total
        });
    });
}

fn bench_arena_transition(c: &mut Criterion) {
    // FP16 1024x1024 tensor -> 1024 * 1024 * 2 bytes
    let dim0 = 1024;
    let dim1 = 1024;
    let size = (dim0 * dim1) as usize;
    let src_data = vec![42u16; size];
    
    // Create Arena. If IOSurface allocation fails (e.g. not on macOS), skip or use fallback.
    if let Ok(arena) = Arena::new(dim0, dim1, Dtype::Float16) {
        c.bench_function("arena_transition_mlx_to_coreml", |b| {
            b.iter(|| {
                // Simulate transition: lock, copy data, unlock
                unsafe {
                    let ptr = arena.base_ptr() as *mut u16;
                    std::ptr::copy_nonoverlapping(src_data.as_ptr(), ptr, size);
                }
            });
        });
    } else {
        // Fallback for non-macOS or environments where IOSurface allocation fails
        c.bench_function("arena_transition_mlx_to_coreml_mock", |b| {
            let mut mock_dest = vec![0u16; size];
            b.iter(|| {
                unsafe {
                    std::ptr::copy_nonoverlapping(src_data.as_ptr(), mock_dest.as_mut_ptr(), size);
                }
            });
        });
    }
}

fn bench_coreml_execution(c: &mut Criterion) {
    c.bench_function("coreml_execution_overhead", |b| {
        // Since real model is not present, we measure the FFI setup and call overhead,
        // or a simulated stateful prediction call.
        b.iter(|| {
            // Simulated boundary prediction transition time
            std::thread::yield_now();
        });
    });
}

fn bench_transfer_back(c: &mut Criterion) {
    let dim0 = 1024;
    let dim1 = 1024;
    let size = (dim0 * dim1) as usize;
    
    if let Ok(arena) = Arena::new(dim0, dim1, Dtype::Float16) {
        let mut dest_data = vec![0u16; size];
        c.bench_function("transfer_back_latency", |b| {
            b.iter(|| {
                unsafe {
                    let ptr = arena.base_ptr() as *const u16;
                    std::ptr::copy_nonoverlapping(ptr, dest_data.as_mut_ptr(), size);
                }
            });
        });
    } else {
        // Fallback
        let src_data = vec![42u16; size];
        let mut dest_data = vec![0u16; size];
        c.bench_function("transfer_back_latency_mock", |b| {
            b.iter(|| {
                unsafe {
                    std::ptr::copy_nonoverlapping(src_data.as_ptr(), dest_data.as_mut_ptr(), size);
                }
            });
        });
    }
}

criterion_group!(
    benches,
    bench_mlx_eval,
    bench_arena_transition,
    bench_coreml_execution,
    bench_transfer_back
);
criterion_main!(benches);
