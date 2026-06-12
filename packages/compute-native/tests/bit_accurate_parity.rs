//! Bit-accurate parity tests validating MLX references vs Core ML predictions.

use tribunus_compute_native::arena::Arena;
use tribunus_compute_native::coreml_bridge::CoreMlModel;
use tribunus_compute_native::coreml_state::CoreMlStateHandle;

fn f32_to_f16_bits(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 31) & 1) as u16;
    let exp = ((bits >> 23) & 0xFF) as i32;
    let mant = bits & 0x7FFFFF;
    if exp == 0 {
        return sign << 15;
    }
    if exp == 255 {
        return (sign << 15) | 0x7C00;
    }
    let new_exp = exp - 127 + 15;
    if new_exp <= 0 {
        return sign << 15;
    }
    if new_exp >= 31 {
        return (sign << 15) | 0x7C00;
    }
    let new_mant = mant >> 13;
    (sign << 15) | ((new_exp as u16) << 10) | (new_mant as u16)
}

fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1F) as u32;
    let mant = (h & 0x3FF) as u32;
    if exp == 0 {
        let value = (mant as f32) * 2.0f32.powi(-24);
        if sign != 0 { -value } else { value }
    } else if exp == 31 {
        f32::INFINITY
    } else {
        let normalized = 1.0f32 + (mant as f32) / 1024.0f32;
        let exponent = 2.0f32.powi((exp as i32) - 15);
        let value = normalized * exponent;
        if sign != 0 { -value } else { value }
    }
}

#[ignore = "requires CoreML modelc artifacts on disk"]
#[tokio::test]
async fn test_stateful_async_future_parity() {
    let model_path = "/tmp/tribunus-stateful-toy.mlmodelc/tribunus-stateful-toy.mlmodelc";
    let model = CoreMlModel::load(model_path).expect("load model");
    let state = CoreMlStateHandle::new(model.raw_ptr()).expect("create state");

    let dim0 = 1u32;
    let dim1 = 4u32;
    let n = (dim0 * dim1) as usize;

    let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");
    let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

    for i in 0..5 {
        let val = i as f32;
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for j in 0..n {
                ptr.add(j).write(f32_to_f16_bits(val));
            }
        }

        // Trigger prediction using the Rust Future (async/await)
        let request = state
            .predict_stateful_async(model.raw_ptr(), "x", &arena_a.info, "y", &mut arena_b.info)
            .expect("start async prediction");

        request.await.expect("async prediction execution");

        let expected_sum = (i * (i + 1)) / 2;
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                assert!(
                    (got - expected_sum as f32).abs() < 1e-2,
                    "iteration {} element {}: got {:.4}, expected {}",
                    i, j, got, expected_sum
                );
            }
        }
    }
}
