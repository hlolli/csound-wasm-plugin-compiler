/*
  hlolli_wg_piano - a struck, dispersive piano-string model for Csound.

  The signal path follows the reduced real-time models described by Balazs
  Bank and Juliette Chabassier in "Model-based digital pianos: from physics
  to sound synthesis" (2018):

  String length, stiffness, and loss also follow Julien Bensa, Stefan Bilbao,
  Richard Kronland-Martinet, and Julius O. Smith III in "The simulation of
  piano string vibration: From physical models to finite difference schemes
  and digital waveguides" (2003).

       felt hammer -> offset, drifting unisons -> short bridge response
       summed notes -> body and sympathetic modes -> shared stereo tail

  This is a new implementation from the equations and design ideas in those
  papers. This module has no samples, tables, files, or platform-specific calls,
  so the same source builds as a native plugin and as a WASI plugin.

  Source: https://github.com/hlolli/hlolli_wg_piano

  SPDX-License-Identifier: MIT
*/

#include <csdl.h>

#include <math.h>
#include <stdint.h>
#include <string.h>

#define WG_STRINGS 3
#define DISPERSION_STAGES 8
#define MIN_DISPERSION_STAGES 4
#define BODY_LINES 4
#define NONLINEAR_MODES 2
#define FELT_MODES 3
#define RESONANCE_BODY_LINES 8
#define RESONANCE_BODY_MODES 12
#define SYMPATHETIC_STRINGS 88
#define PIANO_KEYS 88

#define WG_PIANO_MANAGER_NAME "::hlolli_wg_piano::manager_v1::"

#define WG_PI 3.14159265358979323846264338327950288
#define WG_TWO_PI 6.28318530717958647692528676655900576
#define WG_LN_1000 6.90775527898213705205397436405309262

/* Csound's single-threaded WASI build supplies no-op mutex functions and
   returns NULL from Create_Mutex. Native builds need real locks. */
#if defined(__wasi__)
#define WG_REQUIRE_MUTEXES 0
#else
#define WG_REQUIRE_MUTEXES 1
#endif
#define WG_LOOP_DC_RATIO 0.025

typedef struct {
  double *data;
  uint32_t size;
  uint32_t write_index;
  double delay;
  double loop_previous;
  double dc_input_previous;
  double dc_output_previous;
  double allpass_x[DISPERSION_STAGES];
  double allpass_y[DISPERSION_STAGES];
} WG_STRING;

typedef struct {
  double *data;
  uint32_t size;
  uint32_t write_index;
  double lowpass;
} BODY_LINE;

typedef struct WG_PIANO_STATE_ WG_PIANO_STATE;

typedef struct {
  OPDS h;

  MYFLT *out_left;
  MYFLT *out_right;

  MYFLT *ktrigger;
  MYFLT *kfrequency;
  MYFLT *khardness;
  MYFLT *khammer_position;
  MYFLT *kdecay;
  MYFLT *kstiffness;
  MYFLT *kdetune;
  MYFLT *kbody;
  MYFLT *kstrange;
  MYFLT *kpedal;
  MYFLT *ipiano;

  AUXCH memory;
  WG_STRING strings[WG_STRINGS];
  BODY_LINE body_lines[BODY_LINES];
  double *hammer_history;
  uint32_t hammer_history_size;
  uint32_t hammer_history_index;

  double sample_rate;
  double frequency;
  double hardness;
  double hammer_position;
  double decay;
  double stiffness;
  double detune;
  double body;
  double strange;
  double pedal;

  double last_trigger;
  int32_t trigger_armed;
  uint32_t hammer_sample;
  uint32_t hammer_samples;
  uint32_t hammer_max_samples;
  double hammer_amplitude;
  double hammer_hit_hardness;
  double hammer_contact_power;
  double hammer_contact_stiffness;
  double hammer_contact_peak;
  double hammer_force_scale;
  double hammer_compression;
  double hammer_velocity_state;
  double hammer_string_velocity;
  double hammer_noise_lowpass;
  double hammer_excitation_lowpass[WG_STRINGS];
  double hammer_excitation_lowpass2[WG_STRINGS];
  double unison_static_cents[WG_STRINGS];
  double unison_drift_phase[WG_STRINGS];
  double unison_drift_rate[WG_STRINGS];
  double unison_strike_delay[WG_STRINGS];
  double unison_strike_level[WG_STRINGS];
  double unison_comb_scale[WG_STRINGS];
  double note_tuning_cents;
  double dispersion_frequency[WG_STRINGS];
  double dispersion_stiffness[WG_STRINGS];
  double dispersion_strange[WG_STRINGS];
  double dispersion_coefficient_cache[WG_STRINGS];
  double dispersion_inharmonicity[WG_STRINGS];
  double dispersion_delay_cache[WG_STRINGS];
  uint32_t dispersion_reference_partial[WG_STRINGS];
  uint32_t dispersion_stage_count_cache[WG_STRINGS];
  uint32_t random_state;

  double felt_mode_scale[FELT_MODES];
  double felt_y1[FELT_MODES];
  double felt_y2[FELT_MODES];
  double nonlinear_dc;
  double nonlinear_y1[NONLINEAR_MODES];
  double nonlinear_y2[NONLINEAR_MODES];
  double board_dc;
  double radiation_lowpass;
  double radiation_dc;
  double bridge_lowpass;
  double strange_phase;
  double output_input_left;
  double output_input_right;
  double output_state_left;
  double output_state_right;
  int32_t tuning_initialized;
  WG_PIANO_STATE *piano;
  int32_t piano_handle;
  uint64_t piano_voice_serial;
  uint32_t piano_key;
  int32_t piano_key_down;
} HLOLLI_WG_PIANO;

struct WG_PIANO_STATE_ {
  int32_t handle;
  OPDS *renderer_owner;
  OPDS *renderer_successor;
  OPDS *renderer_retired;
  void *resonance_lock;
  uint64_t render_epoch;
  uint32_t rendered_until;
  uint32_t rendered_samples;
  double render_block_level;
  int32_t render_epoch_valid;
  uint64_t control_epoch;
  int32_t control_epoch_valid;
  void *send_lock;
  uint64_t voice_serial;
  struct WG_PIANO_STATE_ *next;

  MYFLT *send_memory;
  MYFLT *send_left[2];
  MYFLT *send_right[2];
  uint32_t send_ksmps;
  uint64_t send_epoch[2];
  int32_t send_epoch_valid[2];
  uint32_t held_keys[PIANO_KEYS];
  uint32_t held_snapshot[2][PIANO_KEYS];
  uint32_t rendered_held_keys[PIANO_KEYS];
  uint64_t held_epoch[2];
  int32_t held_epoch_valid[2];
  double drift_phase_origin[PIANO_KEYS][WG_STRINGS];
  double drift_rate[PIANO_KEYS][WG_STRINGS];
  double felt_scale[PIANO_KEYS][FELT_MODES];

  double *memory;
  size_t memory_size;
  int32_t resonance_initialized;
  BODY_LINE body_lines[RESONANCE_BODY_LINES];
  double sample_rate;
  double body;
  double pedal;

  double body_mode_cos[RESONANCE_BODY_MODES];
  double body_mode_sin[RESONANCE_BODY_MODES];
  double body_mode_left[RESONANCE_BODY_MODES];
  double body_mode_right[RESONANCE_BODY_MODES];
  double body_mode_y1[RESONANCE_BODY_MODES];
  double body_mode_y2[RESONANCE_BODY_MODES];
  double sympathetic_cos[SYMPATHETIC_STRINGS];
  double sympathetic_sin[SYMPATHETIC_STRINGS];
  double sympathetic_input_side[SYMPATHETIC_STRINGS];
  double sympathetic_radius_closed[SYMPATHETIC_STRINGS];
  double sympathetic_radius_open[SYMPATHETIC_STRINGS];
  double sympathetic_left[SYMPATHETIC_STRINGS];
  double sympathetic_right[SYMPATHETIC_STRINGS];
  double sympathetic_y1[SYMPATHETIC_STRINGS];
  double sympathetic_y2[SYMPATHETIC_STRINGS];

  double input_dc_left;
  double input_dc_right;
  double output_input_left;
  double output_input_right;
  double output_state_left;
  double output_state_right;
  uint32_t quiet_samples;
  int32_t idle;
};

typedef struct {
  WG_PIANO_STATE *first;
  int32_t next_handle;
  void *lock;
} WG_PIANO_MANAGER;

typedef struct {
  OPDS h;
  MYFLT *handle;
} HLOLLI_WG_PIANO_CREATE;

typedef struct {
  OPDS h;
  MYFLT *out_left;
  MYFLT *out_right;
  MYFLT *in_left;
  MYFLT *in_right;
  MYFLT *kbody;
  MYFLT *kpedal;
  WG_PIANO_STATE *piano;
  int32_t owns_renderer;
} HLOLLI_WG_PIANO_RESONANCE_BUS;

typedef struct {
  OPDS h;
  MYFLT *out_left;
  MYFLT *out_right;
  MYFLT *ipiano;
  MYFLT *kbody;
  MYFLT *kpedal;
  WG_PIANO_STATE *piano;
  int32_t owns_renderer;
} HLOLLI_WG_PIANO_RESONANCE_HANDLE;

static double wg_clamp(double value, double low, double high)
{
  if (!isfinite(value)) {
    return low;
  }
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

static double wg_input(const MYFLT *value, double fallback)
{
  const double result = (double)*value;
  return isfinite(result) ? result : fallback;
}

static double wg_smoothstep(double low, double high, double value)
{
  double x = wg_clamp((value - low) / (high - low), 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

/* A grand's dampers clear the strings before the pedal reaches the end of
   its travel. Keep the public 0..1 range, while making 0.82, the normal
   held-pedal value in the examples, a fully open damper state. */
static double wg_pedal_open_amount(double pedal)
{
  return wg_smoothstep(0.0, 0.82, wg_clamp(pedal, 0.0, 1.0));
}

static double wg_frequency_to_midi(double frequency)
{
  return 69.0 + 12.0 * log(frequency / 440.0) / log(2.0);
}

/* Bensa et al. give measured B values rather than a keyboard-wide formula.
   These power curves pass through their C2, C4, and C7 values.  The first
   branch follows the wrapped-bass rise visible in their Fig. 12. */
static double wg_paper_inharmonicity(double frequency)
{
  const double c2_frequency = 65.4065041;
  const double c4_frequency = 261.587302;
  const double c2_b = 8.47682898e-5;
  const double c4_b = 3.57654972e-4;
  double value;

  frequency = wg_clamp(frequency, 27.5, 4186.0);
  if (frequency < c2_frequency) {
    value = c2_b * pow(c2_frequency / frequency, 0.658691);
  } else if (frequency < c4_frequency) {
    value = c2_b * pow(frequency / c2_frequency, 1.038596826);
  } else {
    value = c4_b * pow(frequency / c4_frequency, 1.532498990);
  }
  return wg_clamp(value, 3.0e-5, 3.0e-2);
}

/* A log fit through the C2, C4, and C7 speaking lengths in Table I. */
static double wg_paper_string_length(double frequency)
{
  double length;

  frequency = wg_clamp(frequency, 27.5, 4186.0);
  if (frequency <= 261.587302) {
    length = 1.23 * pow(frequency / 65.4065041, -0.482669);
  } else {
    length = 0.63 * pow(frequency / 261.587302, -0.885056);
  }
  return wg_clamp(length, 0.05, 2.20);
}

static double wg_allpass_phase_amount(double coefficient, double omega)
{
  if (fabs(omega) < 1.0e-9) {
    return omega * (1.0 - coefficient) / (1.0 + coefficient);
  }
  return 2.0 * atan2((1.0 - coefficient) * sin(0.5 * omega),
                     (1.0 + coefficient) * cos(0.5 * omega));
}

static double wg_partial_ratio(double inharmonicity, uint32_t partial)
{
  const double n = (double)partial;
  return n * sqrt((1.0 + inharmonicity * n * n) /
                  (1.0 + inharmonicity));
}

static uint32_t wg_reference_partial(double frequency, double inharmonicity,
                                     double sample_rate)
{
  uint32_t partial = 8U;

  while (partial > 2U &&
         frequency * wg_partial_ratio(inharmonicity, partial) >
             0.35 * sample_rate) {
    partial--;
  }
  return partial;
}

static double wg_dispersion_residual(double coefficient, double omega1,
                                     double omega_reference,
                                     double partial_ratio,
                                     uint32_t partial,
                                     uint32_t stages,
                                     double *delay)
{
  const double phase1 = (double)stages *
                        wg_allpass_phase_amount(coefficient, omega1);
  const double phase_reference = (double)stages *
      wg_allpass_phase_amount(coefficient, omega_reference);

  *delay = (WG_TWO_PI - phase1) / omega1;
  return WG_TWO_PI * partial_ratio + phase_reference -
         partial_ratio * phase1 - WG_TWO_PI * (double)partial;
}

static double wg_solve_dispersion(double omega1, double omega_reference,
                                  double ratio, uint32_t partial,
                                  uint32_t stages, double *delay,
                                  double *error)
{
  double low = -0.98;
  double high = 0.98;
  double low_delay;
  double high_delay;
  double low_error;
  double high_error;
  double coefficient;
  uint32_t iteration;

  low_error = wg_dispersion_residual(
      low, omega1, omega_reference, ratio, partial, stages, &low_delay);
  high_error = wg_dispersion_residual(
      high, omega1, omega_reference, ratio, partial, stages, &high_delay);
  if (low_error >= 0.0) {
    coefficient = low;
    *delay = low_delay;
    *error = low_error;
  } else if (high_error <= 0.0) {
    coefficient = high;
    *delay = high_delay;
    *error = high_error;
  } else {
    for (iteration = 0U; iteration < 30U; iteration++) {
      const double middle = 0.5 * (low + high);
      double middle_delay;
      const double middle_error = wg_dispersion_residual(
          middle, omega1, omega_reference, ratio, partial, stages,
          &middle_delay);
      if (middle_error < 0.0) {
        low = middle;
      } else {
        high = middle;
      }
    }
    coefficient = 0.5 * (low + high);
    *error = wg_dispersion_residual(
        coefficient, omega1, omega_reference, ratio, partial, stages,
        delay);
  }
  return wg_clamp(coefficient, -0.98, 0.98);
}

static double wg_design_dispersion(double frequency, double stiffness,
                                   double strange, double sample_rate,
                                   double *inharmonicity,
                                   uint32_t *reference_partial,
                                   uint32_t *stage_count,
                                   double *delay)
{
  double coefficient;
  double error;
  double ratio;
  double omega1;
  double omega_reference;
  uint32_t stages;
  uint32_t iteration;

  *inharmonicity = wg_paper_inharmonicity(frequency) *
      pow(2.0, 3.5 * (stiffness - 0.42));
  if (strange > 0.0) {
    *inharmonicity *= 1.0 + 6.0 * strange * strange;
  } else {
    *inharmonicity *= 1.0 + 0.45 * strange;
  }
  *inharmonicity = wg_clamp(*inharmonicity, 1.0e-6, 8.0e-2);

  *reference_partial = wg_reference_partial(
      frequency, *inharmonicity, sample_rate);
  ratio = wg_partial_ratio(*inharmonicity, *reference_partial);
  omega1 = WG_TWO_PI * frequency / sample_rate;
  omega_reference = omega1 * ratio;

  for (stages = DISPERSION_STAGES;
       stages >= MIN_DISPERSION_STAGES; stages--) {
    coefficient = wg_solve_dispersion(
        omega1, omega_reference, ratio, *reference_partial, stages,
        delay, &error);
    if (*delay >= 2.25 && fabs(error) < 1.0e-5) {
      *stage_count = stages;
      return coefficient;
    }
  }

  /* The stress range can leave no upper partial below the design band. Keep
     the minimum cascade and move its pole only far enough to preserve the
     cubic delay reader. */
  *stage_count = MIN_DISPERSION_STAGES;
  coefficient = wg_solve_dispersion(
      omega1, omega_reference, ratio, *reference_partial, *stage_count,
      delay, &error);
  if (*delay < 2.25) {
    double unsafe = coefficient;
    double safe = 0.98;
    for (iteration = 0U; iteration < 32U; iteration++) {
      const double middle = 0.5 * (unsafe + safe);
      double middle_delay;
      (void)wg_dispersion_residual(
          middle, omega1, omega_reference, ratio, *reference_partial,
          *stage_count, &middle_delay);
      if (middle_delay < 2.25) {
        unsafe = middle;
      } else {
        safe = middle;
      }
    }
    coefficient = safe;
    (void)wg_dispersion_residual(
        coefficient, omega1, omega_reference, ratio, *reference_partial,
        *stage_count, delay);
  }
  return wg_clamp(coefficient, -0.98, 0.98);
}

static double wg_one_zero_magnitude(double amount, double omega)
{
  const double current = 1.0 - 0.5 * amount;
  const double previous = 0.5 * amount;
  return sqrt(current * current + previous * previous +
              2.0 * current * previous * cos(omega));
}

static uint32_t wg_random(HLOLLI_WG_PIANO *p)
{
  uint32_t x = p->random_state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  p->random_state = x;
  return x;
}

static double wg_white_noise(HLOLLI_WG_PIANO *p)
{
  return ((double)(wg_random(p) >> 8) * (1.0 / 8388607.5)) - 1.0;
}

static void wg_randomize_strike(HLOLLI_WG_PIANO *p)
{
  static const double strike_seconds[WG_STRINGS] = {
      0.0, 0.000007, 0.000015};
  uint32_t index;

  /* A piano tuner leaves the note centre steady, but no two unisons or
     hammer contacts are exact copies. These values stay fixed for one hit. */
  p->note_tuning_cents = 0.065 * wg_white_noise(p);
  for (index = 0U; index < WG_STRINGS; index++) {
    const double error_depth = (index == 0U ? 0.025 : 0.095);
    const double delay_jitter = 0.95 + 0.10 *
        (0.5 + 0.5 * wg_white_noise(p));
    p->unison_static_cents[index] =
        error_depth * wg_white_noise(p);
    p->unison_strike_delay[index] =
        strike_seconds[index] * p->sample_rate * delay_jitter;
    p->unison_strike_level[index] =
        1.0 + 0.026 * wg_white_noise(p);
    p->unison_comb_scale[index] =
        1.0 + 0.002 * wg_white_noise(p);
  }
}

static double wg_delay_read(const double *data, uint32_t size,
                            uint32_t write_index, double delay)
{
  double position = (double)write_index - delay;
  uint32_t index0;
  uint32_t index1;
  double fraction;

  if (position < 0.0) {
    position += (double)size;
  }
  index0 = (uint32_t)position;
  index1 = index0 + 1U;
  if (index1 >= size) {
    index1 = 0U;
  }
  fraction = position - (double)index0;
  return data[index0] + fraction * (data[index1] - data[index0]);
}

static double wg_cubic_delay_read(const double *data, uint32_t size,
                                  uint32_t write_index, double delay)
{
  double position = (double)write_index - delay;
  uint32_t index_minus_1;
  uint32_t index0;
  uint32_t index1;
  uint32_t index2;
  double fraction;
  double weight_minus_1;
  double weight0;
  double weight1;
  double weight2;

  if (position < 0.0) {
    position += (double)size;
  }
  index0 = (uint32_t)position;
  index_minus_1 = (index0 == 0U ? size - 1U : index0 - 1U);
  index1 = index0 + 1U;
  if (index1 >= size) {
    index1 = 0U;
  }
  index2 = index1 + 1U;
  if (index2 >= size) {
    index2 = 0U;
  }

  fraction = position - (double)index0;
  weight_minus_1 =
      -fraction * (fraction - 1.0) * (fraction - 2.0) / 6.0;
  weight0 =
      (fraction + 1.0) * (fraction - 1.0) * (fraction - 2.0) / 2.0;
  weight1 =
      -(fraction + 1.0) * fraction * (fraction - 2.0) / 2.0;
  weight2 =
      (fraction + 1.0) * fraction * (fraction - 1.0) / 6.0;

  return weight_minus_1 * data[index_minus_1] +
         weight0 * data[index0] + weight1 * data[index1] +
         weight2 * data[index2];
}

static double wg_cubic_magnitude(double delay, double omega)
{
  const double position = -delay;
  const double fraction = position - floor(position);
  const double weight_minus_1 =
      -fraction * (fraction - 1.0) * (fraction - 2.0) / 6.0;
  const double weight0 =
      (fraction + 1.0) * (fraction - 1.0) * (fraction - 2.0) / 2.0;
  const double weight1 =
      -(fraction + 1.0) * fraction * (fraction - 2.0) / 2.0;
  const double weight2 =
      (fraction + 1.0) * fraction * (fraction - 1.0) / 6.0;
  const double real = weight_minus_1 * cos(omega) + weight0 +
                      weight1 * cos(omega) +
                      weight2 * cos(2.0 * omega);
  const double imaginary = -weight_minus_1 * sin(omega) +
                           weight1 * sin(omega) +
                           weight2 * sin(2.0 * omega);

  return sqrt(real * real + imaginary * imaginary);
}

static void wg_start_hammer(HLOLLI_WG_PIANO *p, double trigger)
{
  const double velocity = wg_clamp(trigger, 0.0, 1.25);
  const double hardness = wg_clamp(
      p->hardness + 0.18 * (velocity - 0.65), 0.0, 1.0);
  double integral;
  double contact_seconds;
  double reference_contact_seconds;
  double reference_samples;
  double reaction_ratio;
  double maximum_contact_cycles;
  double pitch_scale;
  double samples;

  /* Softer felt stays on the string longer. Real treble hammers are smaller;
     shorten their contact enough that the force window does not span several
     string cycles and cancel the main mode. */
  pitch_scale =
      pow(440.0 / wg_clamp(p->frequency, 440.0, 4186.0), 0.58);
  contact_seconds =
      (0.00022 + 0.0037 * pow(1.0 - hardness, 1.65)) * pitch_scale;
  maximum_contact_cycles = 1.25 + 1.10 * (1.0 - hardness);
  contact_seconds =
      fmin(contact_seconds, maximum_contact_cycles / p->frequency);
  samples = contact_seconds * p->sample_rate;

  p->hammer_samples =
      (uint32_t)wg_clamp(samples, 6.0, p->sample_rate * 0.008);
  p->hammer_max_samples = 2U * p->hammer_samples + 4U;
  p->hammer_sample = 0U;
  p->hammer_amplitude =
      0.62 * pow(velocity, 1.28) * (0.76 + 0.34 * hardness);
  p->hammer_hit_hardness = hardness;
  p->hammer_contact_power = 1.35 + 1.50 * hardness;
  integral = sqrt(WG_PI) *
      tgamma(1.0 / (p->hammer_contact_power + 1.0)) /
      ((p->hammer_contact_power + 1.0) *
       tgamma(1.0 / (p->hammer_contact_power + 1.0) + 0.5));
  p->hammer_contact_peak = 1.0 / (2.0 * integral);
  p->hammer_contact_stiffness =
      (p->hammer_contact_power + 1.0) /
      (2.0 * pow(p->hammer_contact_peak,
                 p->hammer_contact_power + 1.0));
  /* Move partway toward the force impulse implied by the contact ODE. A full
     correction makes hardness act too much like another velocity control. */
  reference_contact_seconds =
      (0.00022 + 0.0037 * pow(1.0 - 0.43, 1.65)) * pitch_scale;
  reference_contact_seconds = fmin(
      reference_contact_seconds,
      (1.25 + 1.10 * (1.0 - 0.43)) / p->frequency);
  reference_samples = (double)(uint32_t)wg_clamp(
      reference_contact_seconds * p->sample_rate,
      6.0, p->sample_rate * 0.008);
  reaction_ratio =
      ((p->hammer_contact_power + 1.0) /
       (2.0 * p->hammer_contact_peak * (double)p->hammer_samples)) /
      ((1.995 + 1.0) /
       (2.0 * 0.35643660289150014 * reference_samples));
  p->hammer_force_scale = wg_clamp(
      pow(reaction_ratio, 0.25), 0.75, 1.80);
  p->hammer_compression = 0.0;
  p->hammer_velocity_state = 1.0;
  wg_randomize_strike(p);
}

static double wg_hammer_tick(HLOLLI_WG_PIANO *p)
{
  double time_step;
  double string_motion;
  double relative_velocity;
  double compression;
  double force_shape;
  double acceleration;
  double hysteresis;
  double felt_noise;
  double noise_cut;
  double force;

  if (p->hammer_sample >= p->hammer_max_samples ||
      p->hammer_samples == 0U) {
    return 0.0;
  }

  time_step = 1.0 / (double)p->hammer_samples;
  string_motion =
      (0.10 + 0.16 * wg_clamp(440.0 / p->frequency, 0.0, 1.0)) *
      tanh(4.0 * p->hammer_string_velocity);
  relative_velocity = p->hammer_velocity_state - string_motion;
  p->hammer_compression += time_step * relative_velocity;

  if (p->hammer_compression <= 0.0 &&
      p->hammer_velocity_state < 0.0 && p->hammer_sample > 2U) {
    p->hammer_compression = 0.0;
    p->hammer_sample = p->hammer_max_samples;
    return 0.0;
  }

  compression = wg_clamp(p->hammer_compression, 0.0,
                         2.5 * p->hammer_contact_peak);
  /* Normalize the felt force at maximum compression. The unscaled law below
     still drives the hammer state; hammer_amplitude sets string coupling. */
  force_shape = pow(compression / p->hammer_contact_peak,
                    p->hammer_contact_power);
  acceleration = p->hammer_contact_stiffness *
                 pow(compression, p->hammer_contact_power);
  p->hammer_velocity_state -= time_step * acceleration;

  /* Felt releases with slightly less force than it stores while loading. */
  hysteresis = relative_velocity < 0.0
      ? 1.0 - (0.035 + 0.075 * (1.0 - p->hammer_hit_hardness)) *
                    wg_clamp(-relative_velocity, 0.0, 1.5)
      : 1.0;
  force_shape *= wg_clamp(hysteresis, 0.72, 1.0);

  /* Felt makes a small, filtered shock. Hard felt admits more high band. */
  noise_cut = 0.08 + 0.72 * p->hammer_hit_hardness;
  p->hammer_noise_lowpass +=
      noise_cut * (wg_white_noise(p) - p->hammer_noise_lowpass);
  felt_noise = p->hammer_noise_lowpass;
  force = p->hammer_amplitude * p->hammer_force_scale * force_shape *
          (1.0 + (0.010 + 0.040 * p->hammer_hit_hardness) * felt_noise);

  p->hammer_sample++;
  return force;
}

static uint32_t wg_odd_size(double sample_rate, double seconds)
{
  uint32_t size = (uint32_t)(sample_rate * seconds + 0.5);
  if (size < 17U) {
    size = 17U;
  }
  if ((size & 1U) == 0U) {
    size++;
  }
  return size;
}

static uint32_t wg_hash_u32(uint32_t value)
{
  value ^= value >> 16U;
  value *= 0x7feb352dU;
  value ^= value >> 15U;
  value *= 0x846ca68bU;
  value ^= value >> 16U;
  return value;
}

static double wg_profile_noise(int32_t handle, uint32_t key,
                               uint32_t lane, uint32_t salt)
{
  uint32_t value = (uint32_t)handle * 0x9e3779b9U;
  value ^= key * 0x85ebca6bU;
  value ^= lane * 0xc2b2ae35U;
  value ^= salt;
  return 2.0 * ((double)wg_hash_u32(value) / 4294967295.0) - 1.0;
}

static void wg_initialize_piano_profile(WG_PIANO_STATE *state)
{
  uint32_t key;
  uint32_t lane;

  for (key = 0U; key < PIANO_KEYS; key++) {
    for (lane = 0U; lane < WG_STRINGS; lane++) {
      state->drift_phase_origin[key][lane] =
          0.5 + 0.5 * wg_profile_noise(state->handle, key, lane,
                                       0x243f6a88U);
      state->drift_rate[key][lane] =
          0.012 + 0.016 *
          (0.5 + 0.5 * wg_profile_noise(state->handle, key, lane,
                                        0x13198a2eU));
    }
    for (lane = 0U; lane < FELT_MODES; lane++) {
      state->felt_scale[key][lane] =
          1.0 + 0.018 * wg_profile_noise(state->handle, key, lane,
                                         0xa4093822U);
    }
  }
}

#if !defined(__wasi__)
static int32_t wg_piano_manager_reset(CSOUND *csound, void *user_data)
{
  WG_PIANO_MANAGER **slot;
  WG_PIANO_MANAGER *manager;
  WG_PIANO_STATE *state;

  IGN(user_data);
  slot = (WG_PIANO_MANAGER **)csound->QueryGlobalVariable(
      csound, WG_PIANO_MANAGER_NAME);
  if (slot == NULL || *slot == NULL) {
    return OK;
  }
  manager = *slot;
  state = manager->first;
  while (state != NULL) {
    WG_PIANO_STATE *next = state->next;
    if (state->resonance_lock != NULL) {
      csound->DestroyMutex(state->resonance_lock);
    }
    if (state->send_lock != NULL) {
      csound->DestroyMutex(state->send_lock);
    }
    csound->Free(csound, state->memory);
    csound->Free(csound, state->send_memory);
    csound->Free(csound, state);
    state = next;
  }
  if (manager->lock != NULL) {
    csound->DestroyMutex(manager->lock);
  }
  csound->Free(csound, manager);
  *slot = NULL;
  csound->DestroyGlobalVariable(csound, WG_PIANO_MANAGER_NAME);
  return OK;
}
#endif

static WG_PIANO_MANAGER *wg_get_piano_manager(CSOUND *csound)
{
  WG_PIANO_MANAGER **slot =
      (WG_PIANO_MANAGER **)csound->QueryGlobalVariable(
          csound, WG_PIANO_MANAGER_NAME);
  WG_PIANO_MANAGER *manager;

  if (slot != NULL && *slot != NULL) {
    return *slot;
  }
  if (slot == NULL &&
      csound->CreateGlobalVariable(csound, WG_PIANO_MANAGER_NAME,
                                   sizeof(WG_PIANO_MANAGER *)) != OK) {
    return NULL;
  }
  slot = (WG_PIANO_MANAGER **)csound->QueryGlobalVariable(
      csound, WG_PIANO_MANAGER_NAME);
  if (slot == NULL) {
    return NULL;
  }
  manager = (WG_PIANO_MANAGER *)csound->Calloc(
      csound, sizeof(WG_PIANO_MANAGER));
  if (manager == NULL) {
    csound->DestroyGlobalVariable(csound, WG_PIANO_MANAGER_NAME);
    return NULL;
  }
  manager->next_handle = 1;
  manager->lock = csound->Create_Mutex(0);
  if (WG_REQUIRE_MUTEXES && manager->lock == NULL) {
    csound->Free(csound, manager);
    csound->DestroyGlobalVariable(csound, WG_PIANO_MANAGER_NAME);
    return NULL;
  }
  *slot = manager;
#if defined(__wasi__)
  /* The WASI loader cannot retain an arbitrary plugin callback in Csound's
     reset list. Csound reset still frees named globals and tracked blocks. */
#else
  if (csound->RegisterResetCallback(csound, manager,
                                    wg_piano_manager_reset) != OK) {
    wg_piano_manager_reset(csound, NULL);
    return NULL;
  }
#endif
  return manager;
}

static uint32_t wg_engine_ksmps(CSOUND *csound)
{
  const double sample_rate = (double)csound->GetEngineSr(csound);
  const double control_rate = (double)csound->GetEngineKr(csound);
  double value;

  if (!isfinite(sample_rate) || !isfinite(control_rate) ||
      sample_rate <= 0.0 || control_rate <= 0.0) {
    return 0U;
  }
  value = sample_rate / control_rate;
  if (!isfinite(value) || value < 1.0 || value > (double)UINT32_MAX) {
    return 0U;
  }
  return (uint32_t)floor(value + 0.5);
}

static WG_PIANO_STATE *wg_find_piano_locked(WG_PIANO_MANAGER *manager,
                                             int32_t handle)
{
  WG_PIANO_STATE *state = manager->first;
  while (state != NULL && state->handle != handle) {
    state = state->next;
  }
  return state;
}

static WG_PIANO_STATE *wg_allocate_piano_state(CSOUND *csound,
                                                int32_t handle,
                                                uint32_t ksmps)
{
  WG_PIANO_STATE *state;
  size_t samples;

  if (ksmps == 0U) {
    return NULL;
  }
  state = (WG_PIANO_STATE *)csound->Calloc(csound,
                                           sizeof(WG_PIANO_STATE));
  if (state == NULL) {
    return NULL;
  }
  state->handle = handle;
  state->send_ksmps = ksmps;
  state->resonance_lock = csound->Create_Mutex(0);
  state->send_lock = csound->Create_Mutex(0);
  samples = 4U * (size_t)ksmps;
  state->send_memory = (MYFLT *)csound->Calloc(
      csound, samples * sizeof(MYFLT));
  if ((WG_REQUIRE_MUTEXES &&
       (state->resonance_lock == NULL || state->send_lock == NULL)) ||
      state->send_memory == NULL) {
    if (state->resonance_lock != NULL) {
      csound->DestroyMutex(state->resonance_lock);
    }
    if (state->send_lock != NULL) {
      csound->DestroyMutex(state->send_lock);
    }
    csound->Free(csound, state->send_memory);
    csound->Free(csound, state);
    return NULL;
  }
  state->send_left[0] = state->send_memory;
  state->send_right[0] = state->send_left[0] + ksmps;
  state->send_left[1] = state->send_right[0] + ksmps;
  state->send_right[1] = state->send_left[1] + ksmps;
  state->idle = 1;
  wg_initialize_piano_profile(state);
  return state;
}

static WG_PIANO_STATE *wg_get_default_piano(CSOUND *csound, uint32_t ksmps)
{
  WG_PIANO_MANAGER *manager = wg_get_piano_manager(csound);
  WG_PIANO_STATE *state;

  if (manager == NULL) {
    return NULL;
  }
  csound->LockMutex(manager->lock);
  state = wg_find_piano_locked(manager, 0);
  if (state == NULL) {
    state = wg_allocate_piano_state(csound, 0, ksmps);
    if (state != NULL) {
      state->next = manager->first;
      manager->first = state;
    }
  }
  csound->UnlockMutex(manager->lock);
  return state;
}

static int32_t wg_read_piano_handle(const MYFLT *value)
{
  const double handle = (double)*value;
  if (!isfinite(handle) || handle < 1.0 ||
      handle > 2147483647.0 || floor(handle) != handle) {
    return -1;
  }
  return (int32_t)handle;
}

static WG_PIANO_STATE *wg_get_piano_by_handle(CSOUND *csound,
                                               int32_t handle)
{
  WG_PIANO_MANAGER *manager = wg_get_piano_manager(csound);
  WG_PIANO_STATE *state;

  if (manager == NULL) {
    return NULL;
  }
  csound->LockMutex(manager->lock);
  state = wg_find_piano_locked(manager, handle);
  csound->UnlockMutex(manager->lock);
  return state;
}

static int32_t hlolli_wg_piano_create_init(
    CSOUND *csound, HLOLLI_WG_PIANO_CREATE *p)
{
  WG_PIANO_MANAGER *manager = wg_get_piano_manager(csound);
  WG_PIANO_STATE *state;
  const uint32_t engine_ksmps = wg_engine_ksmps(csound);
  int32_t handle;

  if (UNLIKELY(manager == NULL)) {
    return csound->InitError(
        csound, "hlolli_wg_piano_create: cannot allocate manager\n");
  }
  if (UNLIKELY(engine_ksmps == 0U)) {
    return csound->InitError(
        csound, "hlolli_wg_piano_create: invalid engine ksmps\n");
  }
  if (UNLIKELY(p->h.insdshead->ksmps != engine_ksmps)) {
    return csound->InitError(
        csound,
        "hlolli_wg_piano_create: piano handles require engine ksmps %u\n",
        engine_ksmps);
  }
  csound->LockMutex(manager->lock);
  handle = manager->next_handle;
  if (handle <= 0 || handle == INT32_MAX) {
    csound->UnlockMutex(manager->lock);
    return csound->InitError(
        csound, "hlolli_wg_piano_create: no handles remain\n");
  }
  state = wg_allocate_piano_state(csound, handle, engine_ksmps);
  if (state == NULL) {
    csound->UnlockMutex(manager->lock);
    return csound->InitError(
        csound, "hlolli_wg_piano_create: cannot allocate piano state\n");
  }
  state->next = manager->first;
  manager->first = state;
  manager->next_handle++;
  csound->UnlockMutex(manager->lock);
  *p->handle = (MYFLT)handle;
  return OK;
}

static void wg_set_note_key_down(CSOUND *csound,
                                 HLOLLI_WG_PIANO *p,
                                 int32_t key_down)
{
  const uint64_t epoch = csound->GetEngineKcounter(csound);
  const uint32_t slot = (uint32_t)(epoch & 1U);
  uint32_t *count;
  uint32_t *snapshot_count;

  if (p->piano == NULL || key_down == p->piano_key_down) {
    return;
  }
  csound->LockMutex(p->piano->send_lock);
  if (!p->piano->held_epoch_valid[slot] ||
      p->piano->held_epoch[slot] != epoch) {
    memcpy(p->piano->held_snapshot[slot], p->piano->held_keys,
           sizeof(p->piano->held_keys));
    p->piano->held_epoch[slot] = epoch;
    p->piano->held_epoch_valid[slot] = 1;
  }
  count = &p->piano->held_keys[p->piano_key];
  snapshot_count = &p->piano->held_snapshot[slot][p->piano_key];
  if (key_down) {
    if (*count != UINT32_MAX) {
      (*count)++;
      (*snapshot_count)++;
    }
  } else if (*count > 0U) {
    (*count)--;
    if (*snapshot_count > 0U) {
      (*snapshot_count)--;
    }
  }
  csound->UnlockMutex(p->piano->send_lock);
  p->piano_key_down = key_down;
}

static void wg_commit_piano_send(CSOUND *csound,
                                 HLOLLI_WG_PIANO *p,
                                 uint32_t offset,
                                 uint32_t limit)
{
  WG_PIANO_STATE *state = p->piano;
  const uint64_t epoch = csound->GetEngineKcounter(csound);
  const uint32_t slot = (uint32_t)(epoch & 1U);
  uint32_t sample;

  if (state == NULL) {
    return;
  }
  csound->LockMutex(state->send_lock);
  if (!state->send_epoch_valid[slot] || state->send_epoch[slot] != epoch) {
    memset(state->send_left[slot], 0,
           state->send_ksmps * sizeof(MYFLT));
    memset(state->send_right[slot], 0,
           state->send_ksmps * sizeof(MYFLT));
    state->send_epoch[slot] = epoch;
    state->send_epoch_valid[slot] = 1;
  }
  for (sample = offset; sample < limit; sample++) {
    state->send_left[slot][sample] += p->out_left[sample];
    state->send_right[slot][sample] += p->out_right[sample];
  }
  csound->UnlockMutex(state->send_lock);
}

static int32_t hlolli_wg_piano_deinit(CSOUND *csound,
                                      HLOLLI_WG_PIANO *p)
{
  wg_set_note_key_down(csound, p, 0);
  p->piano = NULL;
  return OK;
}

static void wg_clear_signal_state(HLOLLI_WG_PIANO *p)
{
  uint32_t index;

  if (p->memory.auxp != NULL && p->memory.size > 0U) {
    memset(p->memory.auxp, 0, p->memory.size);
  }
  for (index = 0U; index < WG_STRINGS; index++) {
    p->strings[index].loop_previous = 0.0;
    p->strings[index].dc_input_previous = 0.0;
    p->strings[index].dc_output_previous = 0.0;
    memset(p->strings[index].allpass_x, 0,
           sizeof(p->strings[index].allpass_x));
    memset(p->strings[index].allpass_y, 0,
           sizeof(p->strings[index].allpass_y));
  }
  for (index = 0U; index < BODY_LINES; index++) {
    p->body_lines[index].lowpass = 0.0;
  }
  p->hammer_noise_lowpass = 0.0;
  memset(p->hammer_excitation_lowpass, 0,
         sizeof(p->hammer_excitation_lowpass));
  memset(p->hammer_excitation_lowpass2, 0,
         sizeof(p->hammer_excitation_lowpass2));
  p->hammer_sample = p->hammer_samples;
  p->hammer_compression = 0.0;
  p->hammer_velocity_state = 0.0;
  p->hammer_string_velocity = 0.0;
  memset(p->felt_y1, 0, sizeof(p->felt_y1));
  memset(p->felt_y2, 0, sizeof(p->felt_y2));
  p->nonlinear_dc = 0.0;
  memset(p->nonlinear_y1, 0, sizeof(p->nonlinear_y1));
  memset(p->nonlinear_y2, 0, sizeof(p->nonlinear_y2));
  p->board_dc = 0.0;
  p->radiation_lowpass = 0.0;
  p->radiation_dc = 0.0;
  p->bridge_lowpass = 0.0;
  p->output_input_left = 0.0;
  p->output_input_right = 0.0;
  p->output_state_left = 0.0;
  p->output_state_right = 0.0;
}

static int32_t hlolli_wg_piano_init(CSOUND *csound, HLOLLI_WG_PIANO *p)
{
  static const double body_seconds[BODY_LINES] = {
      0.01127, 0.01361, 0.01693, 0.01979};
  double *memory;
  double initial_frequency;
  double requested_handle;
  size_t total_doubles;
  uint32_t rail_size;
  uint32_t body_sizes[BODY_LINES];
  uint32_t index;

  if (p->piano != NULL) {
    wg_set_note_key_down(csound, p, 0);
  }
  p->sample_rate = (double)CS_ESR;
  p->piano = NULL;
  p->piano_handle = 0;
  p->piano_voice_serial = 0U;
  p->piano_key = 0U;
  p->piano_key_down = 0;
  if (!(p->sample_rate > 1000.0) || p->sample_rate > 768000.0 ||
      !isfinite(p->sample_rate)) {
    return csound->InitError(csound,
                             "hlolli_wg_piano: invalid sample rate\n");
  }

  rail_size = (uint32_t)(p->sample_rate / 20.0) + 32U;
  total_doubles = (size_t)rail_size * (WG_STRINGS + 1U);
  for (index = 0U; index < BODY_LINES; index++) {
    body_sizes[index] = wg_odd_size(p->sample_rate, body_seconds[index]);
    total_doubles += (size_t)body_sizes[index];
  }

  csound->AuxAlloc(csound, total_doubles * sizeof(double), &p->memory);
  if (UNLIKELY(p->memory.auxp == NULL)) {
    return csound->InitError(csound,
                             "hlolli_wg_piano: cannot allocate delay memory\n");
  }
  memset(p->memory.auxp, 0, total_doubles * sizeof(double));
  memory = (double *)p->memory.auxp;

  for (index = 0U; index < WG_STRINGS; index++) {
    p->strings[index].data = memory;
    p->strings[index].size = rail_size;
    p->strings[index].write_index = 0U;
    p->strings[index].loop_previous = 0.0;
    p->strings[index].dc_input_previous = 0.0;
    p->strings[index].dc_output_previous = 0.0;
    memset(p->strings[index].allpass_x, 0,
           sizeof(p->strings[index].allpass_x));
    memset(p->strings[index].allpass_y, 0,
           sizeof(p->strings[index].allpass_y));
    memory += rail_size;
  }

  p->hammer_history = memory;
  p->hammer_history_size = rail_size;
  p->hammer_history_index = 0U;
  memory += rail_size;

  for (index = 0U; index < BODY_LINES; index++) {
    p->body_lines[index].data = memory;
    p->body_lines[index].size = body_sizes[index];
    p->body_lines[index].write_index = 0U;
    p->body_lines[index].lowpass = 0.0;
    memory += body_sizes[index];
  }

  initial_frequency = wg_clamp(wg_input(p->kfrequency, 440.0), 20.0,
                               0.45 * p->sample_rate);
  requested_handle = p->ipiano != NULL ? (double)*p->ipiano : 0.0;
  if (requested_handle != 0.0) {
    const int32_t handle = wg_read_piano_handle(p->ipiano);
    int32_t midi_key;
    if (UNLIKELY(handle < 1)) {
      return csound->InitError(
          csound, "hlolli_wg_piano: piano handle must be a positive integer\n");
    }
    p->piano = wg_get_piano_by_handle(csound, handle);
    if (UNLIKELY(p->piano == NULL)) {
      return csound->InitError(
          csound, "hlolli_wg_piano: unknown piano handle %d\n", handle);
    }
    if (UNLIKELY(p->piano->send_ksmps != CS_KSMPS)) {
      return csound->InitError(
          csound,
          "hlolli_wg_piano: piano handle %d requires engine ksmps %u\n",
          handle, p->piano->send_ksmps);
    }
    midi_key = (int32_t)floor(wg_frequency_to_midi(initial_frequency) + 0.5);
    if (midi_key < 21) {
      midi_key = 21;
    } else if (midi_key > 108) {
      midi_key = 108;
    }
    p->piano_handle = handle;
    p->piano_key = (uint32_t)(midi_key - 21);
    csound->LockMutex(p->piano->send_lock);
    p->piano->voice_serial++;
    p->piano_voice_serial = p->piano->voice_serial;
    csound->UnlockMutex(p->piano->send_lock);
  }
  p->frequency = initial_frequency;
  p->hardness = wg_clamp(wg_input(p->khardness, 0.45), 0.0, 1.0);
  p->hammer_position =
      wg_clamp(wg_input(p->khammer_position, 0.12), 0.025, 0.45);
  p->decay = wg_clamp(wg_input(p->kdecay, 0.65), 0.0, 1.0);
  p->stiffness = wg_clamp(wg_input(p->kstiffness, 0.45), 0.0, 1.0);
  p->detune = wg_clamp(wg_input(p->kdetune, 0.35), 0.0, 1.0);
  p->body = wg_clamp(wg_input(p->kbody, 0.65), 0.0, 1.0);
  p->strange = wg_clamp(wg_input(p->kstrange, 0.0), -1.0, 1.0);
  p->pedal = wg_clamp(wg_input(p->kpedal, 0.0), 0.0, 1.0);

  for (index = 0U; index < WG_STRINGS; index++) {
    p->strings[index].delay = p->sample_rate / initial_frequency;
  }

  p->last_trigger = 0.0;
  p->trigger_armed = 1;
  p->hammer_sample = 0U;
  p->hammer_samples = 0U;
  p->hammer_max_samples = 0U;
  p->hammer_amplitude = 0.0;
  p->hammer_hit_hardness = p->hardness;
  p->hammer_contact_power = 2.5;
  p->hammer_contact_stiffness = WG_PI * WG_PI;
  p->hammer_contact_peak = 1.0 / WG_PI;
  p->hammer_force_scale = 1.0;
  p->hammer_compression = 0.0;
  p->hammer_velocity_state = 0.0;
  p->hammer_string_velocity = 0.0;
  p->hammer_noise_lowpass = 0.0;
  memset(p->hammer_excitation_lowpass, 0,
         sizeof(p->hammer_excitation_lowpass));
  memset(p->hammer_excitation_lowpass2, 0,
         sizeof(p->hammer_excitation_lowpass2));
  {
    const uint64_t start_sample =
        (uint64_t)csound->GetCurrentTimeSamples(csound);
    const uint64_t instance_salt = p->piano != NULL
        ? 0U : (uint64_t)(uintptr_t)(void *)p;
    const uint64_t piano_salt = p->piano != NULL
        ? ((uint64_t)(uint32_t)p->piano_handle << 32U) ^
              p->piano_voice_serial
        : 0U;
    p->random_state = 0x6d2b79f5U ^ (uint32_t)start_sample ^
                      (uint32_t)(start_sample >> 32U) ^
                      (uint32_t)instance_salt ^
                      (uint32_t)(instance_salt >> 32U) ^
                      (uint32_t)piano_salt ^
                      (uint32_t)(piano_salt >> 32U) ^
                      (uint32_t)(initial_frequency * 655.0);
  }
  if (p->random_state == 0U) {
    p->random_state = 0x9e3779b9U;
  }

  for (index = 0U; index < WG_STRINGS; index++) {
    p->unison_static_cents[index] = 0.0;
    if (p->piano != NULL) {
      const double elapsed =
          ((double)csound->GetCurrentTimeSamples(csound) +
           (double)p->h.insdshead->ksmps_offset) / p->sample_rate;
      p->unison_drift_rate[index] =
          p->piano->drift_rate[p->piano_key][index];
      p->unison_drift_phase[index] =
          p->piano->drift_phase_origin[p->piano_key][index] +
          elapsed * p->unison_drift_rate[index];
      p->unison_drift_phase[index] -=
          floor(p->unison_drift_phase[index]);
    } else {
      p->unison_drift_phase[index] =
          0.5 + 0.5 * wg_white_noise(p);
      p->unison_drift_rate[index] =
          0.012 + 0.016 * (0.5 + 0.5 * wg_white_noise(p));
    }
    p->unison_strike_delay[index] = 0.0;
    p->unison_strike_level[index] = 1.0;
    p->unison_comb_scale[index] = 1.0;
  }
  p->note_tuning_cents = 0.0;
  memset(p->dispersion_frequency, 0, sizeof(p->dispersion_frequency));
  memset(p->dispersion_stiffness, 0, sizeof(p->dispersion_stiffness));
  memset(p->dispersion_strange, 0, sizeof(p->dispersion_strange));
  memset(p->dispersion_coefficient_cache, 0,
         sizeof(p->dispersion_coefficient_cache));
  memset(p->dispersion_inharmonicity, 0,
         sizeof(p->dispersion_inharmonicity));
  memset(p->dispersion_delay_cache, 0,
         sizeof(p->dispersion_delay_cache));
  memset(p->dispersion_reference_partial, 0,
         sizeof(p->dispersion_reference_partial));
  memset(p->dispersion_stage_count_cache, 0,
         sizeof(p->dispersion_stage_count_cache));
  for (index = 0U; index < FELT_MODES; index++) {
    p->felt_mode_scale[index] = p->piano != NULL
        ? p->piano->felt_scale[p->piano_key][index]
        : 1.0 + 0.018 * wg_white_noise(p);
  }
  memset(p->felt_y1, 0, sizeof(p->felt_y1));
  memset(p->felt_y2, 0, sizeof(p->felt_y2));

  p->nonlinear_dc = 0.0;
  memset(p->nonlinear_y1, 0, sizeof(p->nonlinear_y1));
  memset(p->nonlinear_y2, 0, sizeof(p->nonlinear_y2));
  p->board_dc = 0.0;
  p->radiation_lowpass = 0.0;
  p->radiation_dc = 0.0;
  p->bridge_lowpass = 0.0;
  p->strange_phase = 0.0;
  p->output_input_left = 0.0;
  p->output_input_right = 0.0;
  p->output_state_left = 0.0;
  p->output_state_right = 0.0;
  p->tuning_initialized = 0;

  if (wg_input(p->ktrigger, 0.0) > 0.0001) {
    const double trigger = wg_input(p->ktrigger, 0.0);
    wg_start_hammer(p, trigger);
    p->last_trigger = trigger;
    p->trigger_armed = 0;
  }
  wg_set_note_key_down(
      csound, p, wg_input(p->ktrigger, 0.0) > 0.0001);

  return OK;
}

static int32_t hlolli_wg_piano_perf(CSOUND *csound, HLOLLI_WG_PIANO *p)
{
  MYFLT *out_left = p->out_left;
  MYFLT *out_right = p->out_right;
  const double sample_rate = p->sample_rate;
  uint32_t offset = p->h.insdshead->ksmps_offset;
  uint32_t early = p->h.insdshead->ksmps_no_end;
  uint32_t limit = CS_KSMPS - early;
  uint32_t sample;
  uint32_t string_index;

  double trigger_target;
  double frequency_target;
  double block_smoothing;
  double delay_smoothing;
  double string_frequency[WG_STRINGS];
  double delay_target[WG_STRINGS];
  double allpass_coefficient[WG_STRINGS];
  uint32_t dispersion_stage_count[WG_STRINGS];
  double loop_gain[WG_STRINGS];
  double loop_dc_pole[WG_STRINGS];
  double loop_dc_normalization[WG_STRINGS];
  double loss_amount[WG_STRINGS];
  double string_weight[WG_STRINGS];
  double detune_cents;
  double string_count_2;
  double string_count_3;
  double weight_norm;
  double active_weight_sum;
  double coupling;
  double bridge_reflection_pole;
  double bridge_reflection_gain;
  double bridge_reflection_mix;
  double hammer_comb_delay;
  double hammer_filter_mix;
  double hammer_lowpass_coefficient;
  double hammer_excitation_gain;
  double felt_a1[FELT_MODES];
  double felt_a2[FELT_MODES];
  double felt_b0[FELT_MODES];
  double felt_mix;
  double felt_register_gain;
  double body_feedback;
  double body_lowpass_coefficient;
  double body_mix;
  double direct_body_mix;
  double dry_mix;
  double body_chaos;
  double hammer_body_gain;
  double radiation_lowpass_coefficient;
  double treble_amount;
  double nonlinear_a1[NONLINEAR_MODES];
  double nonlinear_a2[NONLINEAR_MODES];
  double nonlinear_b0[NONLINEAR_MODES];
  double nonlinear_mix;
  double nonlinear_dc_coefficient;
  double board_dc_coefficient;
  double output_dc_pole;
  int32_t key_down;

  IGN(csound);

  if (UNLIKELY(offset)) {
    memset(out_left, 0, offset * sizeof(MYFLT));
    memset(out_right, 0, offset * sizeof(MYFLT));
  }
  if (UNLIKELY(early)) {
    memset(&out_left[limit], 0, early * sizeof(MYFLT));
    memset(&out_right[limit], 0, early * sizeof(MYFLT));
  }

  trigger_target = wg_clamp(wg_input(p->ktrigger, 0.0), 0.0, 1.25);
  frequency_target = wg_clamp(wg_input(p->kfrequency, 440.0), 20.0,
                              0.45 * sample_rate);
  key_down = trigger_target > 0.0001;
  wg_set_note_key_down(csound, p, key_down);

  block_smoothing =
      1.0 - exp(-(double)CS_KSMPS / (0.025 * sample_rate));
  delay_smoothing = 1.0 - exp(-1.0 / (0.018 * sample_rate));

  p->frequency += block_smoothing * (frequency_target - p->frequency);
  p->hardness += block_smoothing *
                 (wg_clamp(wg_input(p->khardness, 0.45), 0.0, 1.0) -
                  p->hardness);
  p->hammer_position +=
      block_smoothing *
      (wg_clamp(wg_input(p->khammer_position, 0.12), 0.025, 0.45) -
       p->hammer_position);
  p->decay += block_smoothing *
              (wg_clamp(wg_input(p->kdecay, 0.65), 0.0, 1.0) - p->decay);
  p->stiffness +=
      block_smoothing *
      (wg_clamp(wg_input(p->kstiffness, 0.45), 0.0, 1.0) - p->stiffness);
  p->detune += block_smoothing *
               (wg_clamp(wg_input(p->kdetune, 0.35), 0.0, 1.0) -
                p->detune);
  p->body += block_smoothing *
             (wg_clamp(wg_input(p->kbody, 0.65), 0.0, 1.0) - p->body);
  p->strange +=
      block_smoothing *
      (wg_clamp(wg_input(p->kstrange, 0.0), -1.0, 1.0) - p->strange);
  p->pedal += block_smoothing *
              (wg_clamp(wg_input(p->kpedal, 0.0), 0.0, 1.0) - p->pedal);

  if (key_down &&
      (p->trigger_armed || trigger_target > p->last_trigger + 0.035)) {
    wg_start_hammer(p, trigger_target);
    p->trigger_armed = 0;
  }
  if (!key_down) {
    p->trigger_armed = 1;
  }
  p->last_trigger = trigger_target;

  p->strange_phase +=
      ((double)(limit - offset) / sample_rate) *
      (0.07 + 0.31 * fabs(p->strange));
  if (p->strange_phase >= 1.0) {
    p->strange_phase -= floor(p->strange_phase);
  }

  for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
    p->unison_drift_phase[string_index] +=
        ((double)(limit - offset) / sample_rate) *
        p->unison_drift_rate[string_index];
    if (p->unison_drift_phase[string_index] >= 1.0) {
      p->unison_drift_phase[string_index] -=
          floor(p->unison_drift_phase[string_index]);
    }
  }

  detune_cents = 0.18 + 1.05 * p->detune * p->detune;
  detune_cents *= wg_clamp(
      pow(440.0 / wg_clamp(p->frequency, 440.0, 12000.0), 0.16),
      0.60, 1.0);
  detune_cents += 10.0 * p->strange * p->strange;
  detune_cents *=
      1.0 + 0.18 * sin(WG_TWO_PI * p->strange_phase) * fabs(p->strange);

  {
    static const double spread[WG_STRINGS] = {0.0, 1.0, -0.82};
    static const double drift_sign[WG_STRINGS] = {0.42, 1.0, -0.88};
    const double drift_depth =
        (0.012 + 0.040 * p->detune) *
        (1.0 + 2.2 * fabs(p->strange));
    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      const double drift_cents =
          drift_sign[string_index] * drift_depth *
          sin(WG_TWO_PI * p->unison_drift_phase[string_index]);
      const double cents = p->note_tuning_cents +
                           spread[string_index] * detune_cents +
                           p->unison_static_cents[string_index] +
                           drift_cents;
      string_frequency[string_index] =
          p->frequency * pow(2.0, cents / 1200.0);
    }
  }
  if (p->strange < 0.0) {
    const double down = -p->strange;
    string_frequency[2] *= pow(2.0, -down * down * down);
  }

  /* A grand moves from one bass string to two near E1, then to three near
     C3. The small floors keep dormant rails numerically alive but inaudible. */
  string_count_2 = wg_smoothstep(39.0, 49.0, p->frequency);
  string_count_3 = wg_smoothstep(116.0, 147.0, p->frequency);
  string_weight[0] = 1.0;
  string_weight[1] = 0.015 + 0.985 * string_count_2;
  string_weight[2] = 0.008 + 0.992 * string_count_3;
  weight_norm = 1.0 / sqrt(string_weight[0] * string_weight[0] +
                           string_weight[1] * string_weight[1] +
                           string_weight[2] * string_weight[2]);
  active_weight_sum = string_weight[0] + string_weight[1] +
                      string_weight[2];

  /* This mix runs once per string period. Express its strength as a rate per
     second so a high note does not collapse its unisons faster than a bass. */
  treble_amount = wg_smoothstep(500.0, 2400.0, p->frequency);
  {
    const double coupling_rate =
        0.20 + 0.58 * p->body + 0.75 * treble_amount +
        9.0 * p->strange * p->strange;
    coupling = 1.0 - exp(-coupling_rate /
                         wg_clamp(p->frequency, 20.0, 20000.0));
  }
  coupling = wg_clamp(coupling, 0.0, 0.04);
  bridge_reflection_pole = exp(
      -WG_TWO_PI * (420.0 + 1480.0 * p->body) / sample_rate);
  bridge_reflection_gain =
      wg_clamp(0.997 - 0.023 * p->body, 0.965, 0.998);
  bridge_reflection_mix = 0.10 + 0.28 * p->body;

  for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
    static const double unison_loss_scale[WG_STRINGS] = {
        1.000, 1.035, 0.965};
    double frequency = wg_clamp(string_frequency[string_index], 20.0,
                                0.43 * sample_rate);
    double inharmonicity;
    double coefficient;
    double dispersion_delay;
    double length;
    double calibrated_frequency;
    double ideal_frequency;
    double b1;
    double b2;
    double decay_shape;
    double loss_scale;
    double beta1;
    double lambda1;
    double lambda_reference;
    double reference_ratio;
    double target_ratio;
    double ratio_squared;
    double d1;
    double d_reference;
    double slope;
    double denominator;
    double midi;
    double damper_presence;
    double pedal_open;
    double damper_contact;
    double damper_t60;
    double damper_rate;
    double omega;
    double omega_reference;
    double loss_phase_delay;
    double loss_magnitude;
    double dc_filter_real;
    double dc_filter_imaginary;
    double dc_filter_magnitude;
    double dc_filter_phase_delay;
    double interpolation_magnitude;
    double wanted_round_trip;
    double measured_round_trip;
    double wanted_delay;
    uint32_t reference_partial;
    uint32_t active_dispersion_stages;

    /* The phase fit uses a short bisection.  Reuse it until a control moves
       far enough to change the result; normal held notes then pay once. */
    if (!(p->dispersion_frequency[string_index] > 0.0) ||
        fabs(frequency - p->dispersion_frequency[string_index]) >
            1.2e-5 * frequency ||
        fabs(p->stiffness - p->dispersion_stiffness[string_index]) >
            2.0e-4 ||
        fabs(p->strange - p->dispersion_strange[string_index]) > 2.0e-4) {
      coefficient = wg_design_dispersion(
          frequency, p->stiffness, p->strange, sample_rate,
          &inharmonicity, &reference_partial,
          &active_dispersion_stages, &dispersion_delay);
      if (active_dispersion_stages !=
          p->dispersion_stage_count_cache[string_index]) {
        const uint32_t first_changed = active_dispersion_stages <
            p->dispersion_stage_count_cache[string_index]
            ? active_dispersion_stages
            : p->dispersion_stage_count_cache[string_index];
        const uint32_t last_changed = active_dispersion_stages >
            p->dispersion_stage_count_cache[string_index]
            ? active_dispersion_stages
            : p->dispersion_stage_count_cache[string_index];
        uint32_t stage;
        for (stage = first_changed; stage < last_changed; stage++) {
          p->strings[string_index].allpass_x[stage] = 0.0;
          p->strings[string_index].allpass_y[stage] = 0.0;
        }
      }
      p->dispersion_frequency[string_index] = frequency;
      p->dispersion_stiffness[string_index] = p->stiffness;
      p->dispersion_strange[string_index] = p->strange;
      p->dispersion_coefficient_cache[string_index] = coefficient;
      p->dispersion_inharmonicity[string_index] = inharmonicity;
      p->dispersion_delay_cache[string_index] = dispersion_delay;
      p->dispersion_reference_partial[string_index] = reference_partial;
      p->dispersion_stage_count_cache[string_index] =
          active_dispersion_stages;
    } else {
      coefficient = p->dispersion_coefficient_cache[string_index];
      inharmonicity = p->dispersion_inharmonicity[string_index];
      dispersion_delay = p->dispersion_delay_cache[string_index];
      reference_partial =
          p->dispersion_reference_partial[string_index];
      active_dispersion_stages =
          p->dispersion_stage_count_cache[string_index];
    }
    allpass_coefficient[string_index] = coefficient;
    dispersion_stage_count[string_index] = active_dispersion_stages;

    omega = WG_TWO_PI * frequency / sample_rate;
    reference_ratio = wg_partial_ratio(inharmonicity, reference_partial);
    omega_reference = wg_clamp(omega * reference_ratio,
                               omega, 0.90 * WG_PI);

    calibrated_frequency = wg_clamp(frequency, 27.5, 4186.0);
    length = wg_paper_string_length(calibrated_frequency);
    ideal_frequency = frequency / sqrt(1.0 + inharmonicity);
    b1 = wg_clamp(4.4e-3 * calibrated_frequency - 4.0e-2,
                  0.02, 20.0);
    b2 = wg_clamp(1.0e-6 * calibrated_frequency + 1.0e-5,
                  2.0e-5, 4.5e-3);

    /* kDecay keeps its established curve, with 0.70 now anchored to the
       measured equivalent-string loss in Bensa et al. */
    decay_shape = 0.22 + 2.15 * p->decay * p->decay;
    loss_scale = wg_clamp(1.2735 / decay_shape, 0.537, 5.79) *
                 unison_loss_scale[string_index];
    /* The paper's equivalent-string loss already includes the measured
       bridge.  Trim the small extra loss from this reduced unison junction. */
    loss_scale *= 0.92 - 0.06 *
        wg_smoothstep(65.0, 262.0, calibrated_frequency);
    if (p->strange < 0.0) {
      loss_scale *= 1.0 + 0.55 * (-p->strange);
    }
    loss_scale /= 1.0 + 0.35 * p->strange * p->strange;

    beta1 = WG_PI / length;
    lambda1 = loss_scale * (b1 + b2 * beta1 * beta1);
    lambda_reference = loss_scale *
        (b1 + b2 * beta1 * beta1 *
                  (double)(reference_partial * reference_partial));

    /* Dampers add fast termination loss. The one-zero tilts that loss where
       its range permits. High keys lack dampers; half pedal opens slowly. */
    midi = wg_frequency_to_midi(calibrated_frequency);
    damper_presence = 1.0 - wg_smoothstep(88.0, 94.0, midi);
    pedal_open = wg_pedal_open_amount(p->pedal);
    damper_contact = key_down ? 0.0 :
        damper_presence * (1.0 - pedal_open);
    damper_t60 = 0.18 - 0.115 * wg_smoothstep(36.0, 84.0, midi);
    damper_t60 = wg_clamp(damper_t60, 0.055, 0.18);
    damper_rate = WG_LN_1000 / damper_t60;
    lambda1 += damper_contact * damper_rate;
    lambda_reference += damper_contact * damper_rate *
        (1.0 + 0.055 * ((double)reference_partial - 1.0));

    target_ratio = exp(-(lambda_reference - lambda1) /
                       wg_clamp(ideal_frequency, 20.0, 20000.0));
    ratio_squared = target_ratio * target_ratio;
    d1 = 1.0 - cos(omega);
    d_reference = 1.0 - cos(omega_reference);
    denominator = d_reference - ratio_squared * d1;
    slope = denominator > 1.0e-12
        ? (1.0 - ratio_squared) / denominator : 0.0;
    slope = wg_clamp(slope, 0.0, 0.499999);
    loss_amount[string_index] = wg_clamp(
        1.0 - sqrt(1.0 - 2.0 * slope), 0.0, 0.98);

    loop_dc_pole[string_index] =
        exp(-WG_TWO_PI * WG_LOOP_DC_RATIO * frequency / sample_rate);
    loop_dc_normalization[string_index] =
        0.5 * (1.0 + loop_dc_pole[string_index]);
    loss_phase_delay =
        atan2(0.5 * loss_amount[string_index] * sin(omega),
              1.0 - 0.5 * loss_amount[string_index] +
                  0.5 * loss_amount[string_index] * cos(omega)) /
        omega;
    {
      const double numerator_real = 1.0 - cos(omega);
      const double numerator_imaginary = sin(omega);
      const double denominator_real =
          1.0 - loop_dc_pole[string_index] * cos(omega);
      const double denominator_imaginary =
          loop_dc_pole[string_index] * sin(omega);
      const double denominator_power =
          denominator_real * denominator_real +
          denominator_imaginary * denominator_imaginary;
      const double highpass_real =
          loop_dc_normalization[string_index] *
          (numerator_real * denominator_real +
           numerator_imaginary * denominator_imaginary) /
          denominator_power;
      const double highpass_imaginary =
          loop_dc_normalization[string_index] *
          (numerator_imaginary * denominator_real -
           numerator_real * denominator_imaginary) /
          denominator_power;
      dc_filter_real =
          (1.0 - treble_amount) + treble_amount * highpass_real;
      dc_filter_imaginary = treble_amount * highpass_imaginary;
    }
    dc_filter_magnitude =
        sqrt(dc_filter_real * dc_filter_real +
             dc_filter_imaginary * dc_filter_imaginary);
    dc_filter_phase_delay =
        -atan2(dc_filter_imaginary, dc_filter_real) / omega;
    wanted_delay =
        wg_clamp(dispersion_delay - loss_phase_delay -
                     dc_filter_phase_delay,
                 2.05, (double)p->strings[string_index].size - 3.0);
    delay_target[string_index] = wanted_delay;

    loss_magnitude = wg_one_zero_magnitude(
        loss_amount[string_index], omega);
    interpolation_magnitude = wg_cubic_magnitude(wanted_delay, omega);
    wanted_round_trip = exp(-lambda1 /
                            wg_clamp(ideal_frequency, 20.0, 20000.0));
    measured_round_trip =
        wg_clamp(loss_magnitude * interpolation_magnitude *
                     dc_filter_magnitude,
                 0.25, 1.25);
    loop_gain[string_index] =
        wg_clamp(wanted_round_trip / measured_round_trip,
                 0.0, 0.9998);
    if ((1.0 - treble_amount) * loop_gain[string_index] > 0.9995) {
      loop_gain[string_index] = 0.9995 / (1.0 - treble_amount);
    }
  }

  if (!p->tuning_initialized) {
    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      p->strings[string_index].delay = delay_target[string_index];
    }
    p->tuning_initialized = 1;
  }

  hammer_comb_delay =
      (sample_rate / p->frequency) *
      wg_clamp(p->hammer_position + 0.055 * p->strange, 0.025, 0.48);
  hammer_comb_delay =
      wg_clamp(hammer_comb_delay, 1.0,
               (double)p->hammer_history_size - 3.0);

  /* On a short treble rail the hammer-position comb exposes a very sharp
     edge. A note-scaled felt filter keeps the physical comb notches while
     making upper partials fall away sooner. Strange bypasses most of this
     filter so that the hard, picked character remains available. */
  hammer_filter_mix =
      (0.58 + 0.37 * treble_amount) *
      (1.0 - 0.80 * fabs(p->strange));
  hammer_excitation_gain =
      1.0 - 0.32 * treble_amount * treble_amount *
                (1.0 - 0.70 * fabs(p->strange));
  {
    double hammer_cutoff =
        650.0 + p->frequency *
        (0.85 + 1.15 * p->hardness + 2.8 * fabs(p->strange));
    hammer_cutoff = wg_clamp(hammer_cutoff, 550.0, 0.42 * sample_rate);
    hammer_lowpass_coefficient =
        exp(-WG_TWO_PI * hammer_cutoff / sample_rate);
  }

  felt_mix =
      (0.055 + 0.095 * p->body) *
      (1.12 - 0.38 * p->hardness) *
      (1.0 + 0.35 * fabs(p->strange));
  felt_register_gain =
      (1.0 - 0.14 * wg_smoothstep(0.0, 0.22, treble_amount)) *
      (1.0 - 0.98 * wg_smoothstep(0.22, 0.88, treble_amount));
  for (string_index = 0U; string_index < FELT_MODES; string_index++) {
    static const double mode_hz[FELT_MODES] = {430.0, 1040.0, 2380.0};
    static const double mode_t60[FELT_MODES] = {0.058, 0.041, 0.026};
    const double mode_frequency = wg_clamp(
        mode_hz[string_index] * p->felt_mode_scale[string_index] *
            (0.94 + 0.06 * treble_amount),
        90.0, 0.42 * sample_rate);
    const double t60 =
        mode_t60[string_index] * (0.78 + 0.34 * p->body);
    const double radius = exp(-WG_LN_1000 / (t60 * sample_rate));
    felt_a1[string_index] =
        2.0 * radius * cos(WG_TWO_PI * mode_frequency / sample_rate);
    felt_a2[string_index] = -(radius * radius);
    felt_b0[string_index] = 1.0 - radius;
  }

  /* This per-note network now acts only as a short bridge response.  The
     persistent board and pedal resonances live in hlolli_wg_piano_resonance. */
  body_feedback =
      0.44 + 0.19 * p->body + 0.025 * p->decay;
  body_feedback += 0.025 * p->strange * p->strange;
  body_feedback = wg_clamp(body_feedback, 0.40, 0.72);
  {
    double body_cutoff = 2800.0 + 5200.0 * p->body +
                         5200.0 * (p->strange > 0.0 ? p->strange : 0.0);
    body_cutoff = wg_clamp(body_cutoff, 500.0, 0.42 * sample_rate);
    body_lowpass_coefficient = exp(-WG_TWO_PI * body_cutoff / sample_rate);
  }
  body_mix = 0.12 * p->body * (1.0 + 0.18 * treble_amount);
  direct_body_mix =
      (0.055 + 0.11 * p->body) * (0.25 + 0.75 * treble_amount);
  dry_mix =
      0.22 * (1.0 - 0.32 * treble_amount * (0.35 + 0.65 * p->body));
  body_chaos = 0.72 * fabs(p->strange);
  hammer_body_gain =
      0.015 + 0.085 / (1.0 + pow(p->frequency / 1600.0, 2.0)) +
      0.055 * treble_amount * (0.45 + 0.55 * p->body);
  {
    double radiation_cutoff =
        3200.0 + 6200.0 * p->body;
    radiation_cutoff =
        wg_clamp(radiation_cutoff, 1200.0, 0.42 * sample_rate);
    radiation_lowpass_coefficient =
        exp(-WG_TWO_PI * radiation_cutoff / sample_rate);
  }

  nonlinear_mix =
      0.007 * wg_clamp((720.0 - p->frequency) / 680.0, 0.0, 1.0) +
      0.11 * pow(fabs(p->strange), 1.55);
  nonlinear_dc_coefficient =
      1.0 - exp(-WG_TWO_PI * 5.35 / sample_rate);
  board_dc_coefficient =
      1.0 - exp(-WG_TWO_PI * 9.17 / sample_rate);
  output_dc_pole = exp(-WG_TWO_PI * 4.97 / sample_rate);
  for (string_index = 0U; string_index < NONLINEAR_MODES; string_index++) {
    const double ratio = (string_index == 0U ? 5.45 : 8.73) +
                         (string_index == 0U ? 0.8 : -0.6) * p->strange;
    const double mode_frequency =
        wg_clamp(p->frequency * ratio, 70.0, 0.43 * sample_rate);
    const double mode_decay = 0.055 + 0.18 * p->body +
                              0.24 * fabs(p->strange);
    const double radius = exp(-1.0 / (mode_decay * sample_rate));
    nonlinear_a1[string_index] =
        2.0 * radius * cos(WG_TWO_PI * mode_frequency / sample_rate);
    nonlinear_a2[string_index] = -(radius * radius);
    nonlinear_b0[string_index] = 1.0 - radius;
  }

  for (sample = offset; sample < limit; sample++) {
    static const double pan[WG_STRINGS] = {-0.12, 0.12, 0.0};
    static const double body_injection[BODY_LINES] = {
        0.33, -0.29, 0.24, -0.20};
    static const double felt_weight[FELT_MODES] = {1.0, -0.58, 0.31};
    double hammer = wg_hammer_tick(p);
    double hammer_input[WG_STRINGS];
    double hammer_point_motion = 0.0;
    double loop_signal[WG_STRINGS];
    double loop_average = 0.0;
    double reflected_common;
    double bridge = 0.0;
    double dry_left = 0.0;
    double dry_right = 0.0;
    double quadratic;
    double nonlinear = 0.0;
    double felt_echo1;
    double felt_echo2;
    double felt_drive;
    double felt_resonance = 0.0;
    double bridge_input;
    double board_input;
    double radiation;
    double body_out[BODY_LINES];
    double hadamard[BODY_LINES];
    double cycle[BODY_LINES];
    double body_left;
    double body_right;
    double result_left;
    double result_right;
    double filtered_left;
    double filtered_right;

    p->hammer_history[p->hammer_history_index] = hammer;
    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      const double strike_delay = p->unison_strike_delay[string_index];
      const double direct_hammer = wg_delay_read(
          p->hammer_history, p->hammer_history_size,
          p->hammer_history_index, strike_delay);
      const double comb_delay = wg_clamp(
          hammer_comb_delay * p->unison_comb_scale[string_index] +
              strike_delay,
          1.0, (double)p->hammer_history_size - 3.0);
      const double delayed_hammer = wg_delay_read(
          p->hammer_history, p->hammer_history_size,
          p->hammer_history_index, comb_delay);
      const double comb_base = wg_clamp(
          0.60 + 0.14 * p->hardness + 0.10 * fabs(p->strange),
          0.45, 0.98);
      const double comb_resolution =
          wg_smoothstep(2.0, 8.0, comb_delay);
      const double comb_amount =
          comb_base * (0.42 + 0.58 * comb_resolution);
      const double raw_hammer_input =
          hammer_excitation_gain *
          (direct_hammer - comb_amount * delayed_hammer);

      p->hammer_excitation_lowpass[string_index] =
          hammer_lowpass_coefficient *
              p->hammer_excitation_lowpass[string_index] +
          (1.0 - hammer_lowpass_coefficient) * raw_hammer_input;
      p->hammer_excitation_lowpass2[string_index] =
          hammer_lowpass_coefficient *
              p->hammer_excitation_lowpass2[string_index] +
          (1.0 - hammer_lowpass_coefficient) *
              p->hammer_excitation_lowpass[string_index];
      hammer_input[string_index] =
          raw_hammer_input + hammer_filter_mix *
              (p->hammer_excitation_lowpass2[string_index] -
               raw_hammer_input);
      hammer_point_motion += hammer_input[string_index] *
          string_weight[string_index] / active_weight_sum;
    }

    /* The felt and hammer shank have short resonances of their own. Two tiny
       delayed feeds and three damped modes put that soft body before the
       longer soundboard response without making another lasting string loop. */
    felt_echo1 = wg_delay_read(
        p->hammer_history, p->hammer_history_size,
        p->hammer_history_index, 0.00038 * sample_rate);
    felt_echo2 = wg_delay_read(
        p->hammer_history, p->hammer_history_size,
        p->hammer_history_index, 0.00091 * sample_rate);
    felt_drive = hammer + 0.34 * felt_echo1 - 0.18 * felt_echo2;
    for (string_index = 0U; string_index < FELT_MODES; string_index++) {
      const double register_tilt =
          (string_index == 0U ? 1.0 - 0.75 * treble_amount :
           string_index == 1U ? 1.0 - 0.35 * treble_amount : 1.0);
      const double mode = felt_b0[string_index] * felt_drive +
                          felt_a1[string_index] * p->felt_y1[string_index] +
                          felt_a2[string_index] * p->felt_y2[string_index];
      p->felt_y2[string_index] = p->felt_y1[string_index];
      p->felt_y1[string_index] = mode;
      felt_resonance += felt_weight[string_index] * register_tilt * mode;
    }
    felt_resonance *= felt_register_gain;

    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      WG_STRING *string = &p->strings[string_index];
      double value;
      uint32_t stage;

      string->delay +=
          delay_smoothing * (delay_target[string_index] - string->delay);
      value = wg_cubic_delay_read(string->data, string->size,
                                  string->write_index, string->delay);

      for (stage = 0U;
           stage < dispersion_stage_count[string_index]; stage++) {
        const double output =
            allpass_coefficient[string_index] * value +
            string->allpass_x[stage] -
            allpass_coefficient[string_index] * string->allpass_y[stage];
        string->allpass_x[stage] = value;
        string->allpass_y[stage] = output;
        value = output;
      }

      loop_signal[string_index] =
          (1.0 - loss_amount[string_index]) * value +
          0.5 * loss_amount[string_index] *
              (value + string->loop_previous);
      string->loop_previous = value;
      {
        const double highpass =
            loop_dc_normalization[string_index] *
                (loop_signal[string_index] -
                 string->dc_input_previous) +
            loop_dc_pole[string_index] * string->dc_output_previous;
        string->dc_input_previous = loop_signal[string_index];
        string->dc_output_previous = highpass;
        loop_signal[string_index] +=
            treble_amount * (highpass - loop_signal[string_index]);
      }
      loop_average += loop_signal[string_index] *
                      string_weight[string_index] / active_weight_sum;
    }

    p->bridge_lowpass =
        bridge_reflection_pole * p->bridge_lowpass +
        (1.0 - bridge_reflection_pole) * loop_average;
    reflected_common = bridge_reflection_gain *
        ((1.0 - bridge_reflection_mix) * loop_average +
         bridge_reflection_mix * p->bridge_lowpass);
    /* The outgoing strike wave gives the contact an immediate local-motion
       estimate; the returned loop adds the later reflected string motion. */
    p->hammer_string_velocity =
        loop_average + 0.14 * hammer_point_motion;

    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      WG_STRING *string = &p->strings[string_index];
      const double rail_coupling =
          coupling * string_weight[string_index];
      const double junction =
          reflected_common + loop_average - loop_signal[string_index];
      const double mixed =
          (1.0 - rail_coupling) * loop_signal[string_index] +
          rail_coupling * junction;
      const double injection =
          0.94 * hammer_input[string_index] *
          p->unison_strike_level[string_index] *
          string_weight[string_index] * weight_norm;
      const double rail_output = loop_signal[string_index];
      const double panning = pan[string_index];

      string->data[string->write_index] =
          loop_gain[string_index] * mixed + injection;
      string->write_index++;
      if (string->write_index >= string->size) {
        string->write_index = 0U;
      }

      bridge += rail_output * string_weight[string_index] * weight_norm;
      dry_left += rail_output * string_weight[string_index] * weight_norm *
                  (0.7071 * (1.0 - panning));
      dry_right += rail_output * string_weight[string_index] * weight_norm *
                   (0.7071 * (1.0 + panning));
    }

    p->hammer_history_index++;
    if (p->hammer_history_index >= p->hammer_history_size) {
      p->hammer_history_index = 0U;
    }

    quadratic = bridge * bridge;
    p->nonlinear_dc +=
        nonlinear_dc_coefficient * (quadratic - p->nonlinear_dc);
    quadratic -= p->nonlinear_dc;
    for (string_index = 0U; string_index < NONLINEAR_MODES;
         string_index++) {
      const double mode =
          nonlinear_b0[string_index] * quadratic +
          nonlinear_a1[string_index] * p->nonlinear_y1[string_index] +
          nonlinear_a2[string_index] * p->nonlinear_y2[string_index];
      p->nonlinear_y2[string_index] = p->nonlinear_y1[string_index];
      p->nonlinear_y1[string_index] = mode;
      nonlinear += mode * (string_index == 0U ? 1.0 : -0.72);
    }

    p->board_dc += board_dc_coefficient * (bridge - p->board_dc);
    bridge_input =
        (bridge - p->board_dc) * (0.16 + 0.64 * p->body) +
        nonlinear_mix * nonlinear;
    board_input = bridge_input + hammer_body_gain *
                                      (0.62 * hammer +
                                       0.55 * felt_resonance);

    /* A real soundboard has an immediate radiation path. The delay network
       below supplies its dense, short tail; this filtered feedthrough keeps
       the first treble cycles from exposing the bare waveguide. */
    p->radiation_lowpass =
        radiation_lowpass_coefficient * p->radiation_lowpass +
        (1.0 - radiation_lowpass_coefficient) *
            (bridge_input + 0.38 * felt_mix * felt_resonance);
    p->radiation_dc += board_dc_coefficient *
        (p->radiation_lowpass - p->radiation_dc);
    radiation = p->radiation_lowpass - p->radiation_dc;

    for (string_index = 0U; string_index < BODY_LINES; string_index++) {
      BODY_LINE *line = &p->body_lines[string_index];
      body_out[string_index] = line->data[line->write_index];
    }

    hadamard[0] = 0.5 * (body_out[0] + body_out[1] +
                         body_out[2] + body_out[3]);
    hadamard[1] = 0.5 * (body_out[0] - body_out[1] +
                         body_out[2] - body_out[3]);
    hadamard[2] = 0.5 * (body_out[0] + body_out[1] -
                         body_out[2] - body_out[3]);
    hadamard[3] = 0.5 * (body_out[0] - body_out[1] -
                         body_out[2] + body_out[3]);

    if (p->strange >= 0.0) {
      cycle[0] = body_out[1];
      cycle[1] = -body_out[2];
      cycle[2] = body_out[3];
      cycle[3] = -body_out[0];
    } else {
      cycle[0] = -body_out[3];
      cycle[1] = body_out[0];
      cycle[2] = -body_out[1];
      cycle[3] = body_out[2];
    }

    for (string_index = 0U; string_index < BODY_LINES; string_index++) {
      BODY_LINE *line = &p->body_lines[string_index];
      const double scattered =
          (1.0 - body_chaos) * hadamard[string_index] +
          body_chaos * cycle[string_index];
      line->lowpass =
          body_lowpass_coefficient * line->lowpass +
          (1.0 - body_lowpass_coefficient) * scattered;
      line->data[line->write_index] =
          body_injection[string_index] * board_input +
          body_feedback * line->lowpass;
      line->write_index++;
      if (line->write_index >= line->size) {
        line->write_index = 0U;
      }
    }

    body_left =
        0.5 * (body_out[0] + body_out[1] - body_out[2] + body_out[3]);
    body_right =
        0.5 * (body_out[0] - body_out[1] + body_out[2] + body_out[3]);

    /* The soundboard is wide in the body of the piano, but the shortest
       strings do not radiate as a phase-inverted pair. Keep the top register
       centred while leaving the lower unisons broad. */
    {
      const double stereo_width = 1.0 - 0.66 * treble_amount;
      const double dry_mid = 0.5 * (dry_left + dry_right);
      const double dry_side = 0.5 * (dry_left - dry_right);
      const double body_mid = 0.5 * (body_left + body_right);
      const double body_side = 0.5 * (body_left - body_right);
      dry_left = dry_mid + stereo_width * dry_side;
      dry_right = dry_mid - stereo_width * dry_side;
      body_left = body_mid + stereo_width * body_side;
      body_right = body_mid - stereo_width * body_side;
    }

    result_left = dry_mix * dry_left + body_mix * body_left +
                  0.7071 * direct_body_mix * radiation +
                  0.09 * felt_mix * felt_resonance +
                  0.025 * nonlinear_mix * nonlinear;
    result_right = dry_mix * dry_right + body_mix * body_right +
                   0.7071 * direct_body_mix * radiation +
                   0.08 * felt_mix * felt_resonance -
                   0.021 * nonlinear_mix * nonlinear;

    /* The bridge and soundboard radiate motion, not a static offset. */
    filtered_left = result_left - p->output_input_left +
                    output_dc_pole * p->output_state_left;
    filtered_right = result_right - p->output_input_right +
                     output_dc_pole * p->output_state_right;
    p->output_input_left = result_left;
    p->output_input_right = result_right;
    p->output_state_left = filtered_left;
    p->output_state_right = filtered_right;

    if (UNLIKELY(!isfinite(filtered_left) || !isfinite(filtered_right))) {
      filtered_left = 0.0;
      filtered_right = 0.0;
      wg_clear_signal_state(p);
    }

    {
      const double drive = 1.0 + 0.65 * fabs(p->strange);
      out_left[sample] =
          (MYFLT)(tanh(drive * 1.8 * filtered_left) / drive);
      out_right[sample] =
          (MYFLT)(tanh(drive * 1.8 * filtered_right) / drive);
    }
  }

  wg_commit_piano_send(csound, p, offset, limit);

  return OK;
}

static void wg_hadamard8(const double *input, double *output)
{
  const double a0 = input[0] + input[1];
  const double a1 = input[0] - input[1];
  const double a2 = input[2] + input[3];
  const double a3 = input[2] - input[3];
  const double a4 = input[4] + input[5];
  const double a5 = input[4] - input[5];
  const double a6 = input[6] + input[7];
  const double a7 = input[6] - input[7];
  const double b0 = a0 + a2;
  const double b1 = a1 + a3;
  const double b2 = a0 - a2;
  const double b3 = a1 - a3;
  const double b4 = a4 + a6;
  const double b5 = a5 + a7;
  const double b6 = a4 - a6;
  const double b7 = a5 - a7;
  const double scale = 0.35355339059327376220;

  output[0] = scale * (b0 + b4);
  output[1] = scale * (b1 + b5);
  output[2] = scale * (b2 + b6);
  output[3] = scale * (b3 + b7);
  output[4] = scale * (b0 - b4);
  output[5] = scale * (b1 - b5);
  output[6] = scale * (b2 - b6);
  output[7] = scale * (b3 - b7);
}

static void wg_resonance_clear(WG_PIANO_STATE *p)
{
  uint32_t index;

  if (p->memory != NULL && p->memory_size > 0U) {
    memset(p->memory, 0, p->memory_size);
  }
  for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
    p->body_lines[index].lowpass = 0.0;
  }
  memset(p->body_mode_y1, 0, sizeof(p->body_mode_y1));
  memset(p->body_mode_y2, 0, sizeof(p->body_mode_y2));
  memset(p->sympathetic_y1, 0, sizeof(p->sympathetic_y1));
  memset(p->sympathetic_y2, 0, sizeof(p->sympathetic_y2));
  p->input_dc_left = 0.0;
  p->input_dc_right = 0.0;
  p->output_input_left = 0.0;
  p->output_input_right = 0.0;
  p->output_state_left = 0.0;
  p->output_state_right = 0.0;
  p->quiet_samples = 0U;
  p->idle = 1;
}

static int32_t wg_resonance_state_init(
    CSOUND *csound, OPDS *h, WG_PIANO_STATE *p,
    const MYFLT *kbody, const MYFLT *kpedal)
{
  static const double body_mode_hz[RESONANCE_BODY_MODES] = {
      58.0, 79.0, 108.0, 149.0, 207.0, 291.0,
      413.0, 593.0, 864.0, 1280.0, 1960.0, 3220.0};
  static const double body_line_seconds[RESONANCE_BODY_LINES] = {
      557.0 / 48000.0, 683.0 / 48000.0, 809.0 / 48000.0,
      947.0 / 48000.0, 1151.0 / 48000.0, 1361.0 / 48000.0,
      1601.0 / 48000.0, 1999.0 / 48000.0};
  double *memory;
  size_t total_doubles = 0U;
  uint32_t line_sizes[RESONANCE_BODY_LINES];
  uint32_t index;

  if (p->resonance_initialized) {
    if (UNLIKELY(p->sample_rate != (double)h->insdshead->esr)) {
      return csound->InitError(
          csound,
          "hlolli_wg_piano_resonance: sample rate changed for piano %d\n",
          p->handle);
    }
    return OK;
  }

  p->sample_rate = (double)h->insdshead->esr;
  if (!(p->sample_rate > 1000.0) || p->sample_rate > 768000.0 ||
      !isfinite(p->sample_rate)) {
    return csound->InitError(
        csound, "hlolli_wg_piano_resonance: invalid sample rate\n");
  }

  for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
    line_sizes[index] = wg_odd_size(p->sample_rate,
                                    body_line_seconds[index]);
    total_doubles += (size_t)line_sizes[index];
  }
  p->memory_size = total_doubles * sizeof(double);
  p->memory = (double *)csound->Calloc(csound, p->memory_size);
  if (UNLIKELY(p->memory == NULL)) {
    p->memory_size = 0U;
    return csound->InitError(
        csound, "hlolli_wg_piano_resonance: cannot allocate delay memory\n");
  }
  memory = p->memory;
  for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
    p->body_lines[index].data = memory;
    p->body_lines[index].size = line_sizes[index];
    p->body_lines[index].write_index = 0U;
    p->body_lines[index].lowpass = 0.0;
    memory += line_sizes[index];
  }

  p->body = wg_clamp(wg_input(kbody, 0.72), 0.0, 1.0);
  p->pedal = wg_clamp(wg_input(kpedal, 0.0), 0.0, 1.0);

  for (index = 0U; index < RESONANCE_BODY_MODES; index++) {
    const double frequency = wg_clamp(
        body_mode_hz[index], 20.0, 0.42 * p->sample_rate);
    const double position = -0.55 + 1.10 *
        ((double)index / (double)(RESONANCE_BODY_MODES - 1U));
    const double angle = WG_TWO_PI * frequency / p->sample_rate;
    p->body_mode_cos[index] =
        cos(angle);
    p->body_mode_sin[index] = sin(angle);
    p->body_mode_left[index] = sqrt(0.5 * (1.0 - position));
    p->body_mode_right[index] = sqrt(0.5 * (1.0 + position));
  }

  for (index = 0U; index < SYMPATHETIC_STRINGS; index++) {
    const double midi = 21.0 + (double)index;
    const double frequency = 440.0 * pow(2.0, (midi - 69.0) / 12.0);
    const double position = (double)index /
                            (double)(SYMPATHETIC_STRINGS - 1U);
    const double pan = -0.72 + 1.44 * position;
    const double t60_open =
        0.75 + 4.75 / (1.0 + pow(frequency / 300.0, 0.72));
    const double t60_closed =
        0.090 - 0.035 * wg_smoothstep(36.0, 84.0, midi);

    if (frequency <= 0.42 * p->sample_rate) {
      const double angle = WG_TWO_PI * frequency / p->sample_rate;
      p->sympathetic_cos[index] =
          cos(angle);
      p->sympathetic_sin[index] = sin(angle);
      p->sympathetic_left[index] = sqrt(0.5 * (1.0 - pan));
      p->sympathetic_right[index] = sqrt(0.5 * (1.0 + pan));
    } else {
      p->sympathetic_cos[index] = 1.0;
      p->sympathetic_sin[index] = 0.0;
      p->sympathetic_left[index] = 0.0;
      p->sympathetic_right[index] = 0.0;
    }
    p->sympathetic_input_side[index] = -0.28 * pan;
    p->sympathetic_radius_closed[index] =
        exp(-WG_LN_1000 / (t60_closed * p->sample_rate));
    p->sympathetic_radius_open[index] =
        exp(-WG_LN_1000 / (t60_open * p->sample_rate));
  }

  memset(p->body_mode_y1, 0, sizeof(p->body_mode_y1));
  memset(p->body_mode_y2, 0, sizeof(p->body_mode_y2));
  memset(p->sympathetic_y1, 0, sizeof(p->sympathetic_y1));
  memset(p->sympathetic_y2, 0, sizeof(p->sympathetic_y2));
  p->input_dc_left = 0.0;
  p->input_dc_right = 0.0;
  p->output_input_left = 0.0;
  p->output_input_right = 0.0;
  p->output_state_left = 0.0;
  p->output_state_right = 0.0;
  p->quiet_samples = 0U;
  p->idle = 1;
  p->resonance_initialized = 1;

  return OK;
}

static int32_t wg_resonance_process(
    CSOUND *csound, OPDS *h,
    MYFLT *out_left, MYFLT *out_right,
    const MYFLT *in_left, const MYFLT *in_right,
    const MYFLT *kbody, const MYFLT *kpedal,
    WG_PIANO_STATE *p)
{
  static const double body_mode_t60[RESONANCE_BODY_MODES] = {
      1.50, 1.28, 1.10, 0.91, 0.74, 0.58,
      0.45, 0.35, 0.28, 0.22, 0.18, 0.145};
  static const double body_mode_gain[RESONANCE_BODY_MODES] = {
      0.34, 0.32, 0.30, 0.275, 0.25, 0.225,
      0.20, 0.175, 0.15, 0.125, 0.10, 0.075};
  static const double body_mode_side[RESONANCE_BODY_MODES] = {
      -0.08, 0.06, -0.13, 0.16, -0.19, 0.22,
      -0.26, 0.30, -0.34, 0.38, -0.42, 0.46};
  static const double fdn_input_side[RESONANCE_BODY_LINES] = {
      -0.42, 0.31, -0.20, 0.48, -0.36, 0.16, 0.39, -0.27};
  static const double fdn_injection[RESONANCE_BODY_LINES] = {
      0.23, -0.21, 0.19, -0.17, 0.16, -0.145, 0.13, -0.115};
  static const double fdn_tone_scale[RESONANCE_BODY_LINES] = {
      0.72, 0.83, 0.92, 1.00, 1.09, 1.18, 1.28, 1.38};
  const double sample_rate = p->sample_rate;
  const uint32_t ksmps = h->insdshead->ksmps;
  uint32_t offset = h->insdshead->ksmps_offset;
  uint32_t early = h->insdshead->ksmps_no_end;
  uint32_t limit = ksmps - early;
  double body_radius[RESONANCE_BODY_MODES];
  double sympathetic_radius[SYMPATHETIC_STRINGS];
  double sympathetic_coupling[SYMPATHETIC_STRINGS];
  double sympathetic_drive[SYMPATHETIC_STRINGS];
  int32_t held_keys[SYMPATHETIC_STRINGS];
  double fdn_feedback[RESONANCE_BODY_LINES];
  double fdn_lowpass[RESONANCE_BODY_LINES];
  double body_target;
  double pedal_target;
  double body_smoothing;
  double pedal_smoothing;
  double pedal_open;
  double fdn_t60;
  double fdn_cutoff;
  double input_dc_coefficient;
  double output_dc_pole;
  double block_level = 0.0;
  int32_t input_active = 0;
  uint32_t index;
  uint32_t sample;

  if (UNLIKELY(offset)) {
    memset(out_left, 0, offset * sizeof(MYFLT));
    memset(out_right, 0, offset * sizeof(MYFLT));
  }
  if (UNLIKELY(early)) {
    memset(&out_left[limit], 0, early * sizeof(MYFLT));
    memset(&out_right[limit], 0, early * sizeof(MYFLT));
  }

  body_target = wg_clamp(wg_input(kbody, 0.72), 0.0, 1.0);
  pedal_target = wg_clamp(wg_input(kpedal, 0.0), 0.0, 1.0);
  {
    const uint64_t epoch = csound->GetEngineKcounter(csound);
    if (!p->control_epoch_valid || p->control_epoch != epoch) {
      body_smoothing = 1.0 - exp(-(double)ksmps /
                                 (0.025 * sample_rate));
      pedal_smoothing = 1.0 - exp(-(double)ksmps /
          ((pedal_target > p->pedal ? 0.020 : 0.040) * sample_rate));
      p->body += body_smoothing * (body_target - p->body);
      p->pedal += pedal_smoothing * (pedal_target - p->pedal);
      p->control_epoch = epoch;
      p->control_epoch_valid = 1;
    }
  }

  csound->LockMutex(p->send_lock);
  {
    const uint64_t epoch = csound->GetEngineKcounter(csound);
    if (epoch > 0U) {
      const uint64_t wanted = epoch - 1U;
      const uint32_t slot = (uint32_t)(wanted & 1U);
      if (p->held_epoch_valid[slot] && p->held_epoch[slot] == wanted) {
        memcpy(p->rendered_held_keys, p->held_snapshot[slot],
               sizeof(p->rendered_held_keys));
      }
    }
  }
  for (index = 0U; index < SYMPATHETIC_STRINGS; index++) {
    held_keys[index] = p->rendered_held_keys[index] > 0U;
  }
  csound->UnlockMutex(p->send_lock);

  if (p->idle) {
    for (sample = offset; sample < limit; sample++) {
      const double scan_left = (double)in_left[sample];
      const double scan_right = (double)in_right[sample];
      if ((isfinite(scan_left) && fabs(scan_left) > 1.0e-15) ||
          (isfinite(scan_right) && fabs(scan_right) > 1.0e-15)) {
        input_active = 1;
        break;
      }
    }
    if (!input_active) {
      memset(&out_left[offset], 0,
             (limit - offset) * sizeof(MYFLT));
      memset(&out_right[offset], 0,
             (limit - offset) * sizeof(MYFLT));
      return OK;
    }
    p->idle = 0;
  }
  pedal_open = wg_pedal_open_amount(p->pedal);

  for (index = 0U; index < RESONANCE_BODY_MODES; index++) {
    const double t60 = body_mode_t60[index] * (0.82 + 0.36 * p->body);
    body_radius[index] = wg_clamp(
        exp(-WG_LN_1000 / (t60 * sample_rate)), 0.0, 0.9999995);
  }

  for (index = 0U; index < SYMPATHETIC_STRINGS; index++) {
    const double midi = 21.0 + (double)index;
    const double undamped = wg_smoothstep(88.0, 94.0, midi);
    const double key_open = held_keys[index] ? 1.0 : undamped;
    const double decay_open =
        pedal_open + (1.0 - pedal_open) * key_open;
    const double drive_open = pedal_open + (1.0 - pedal_open) *
        (held_keys[index] ? 1.0 : 0.25 * undamped);
    sympathetic_radius[index] = wg_clamp(
        p->sympathetic_radius_closed[index] + decay_open *
            (p->sympathetic_radius_open[index] -
             p->sympathetic_radius_closed[index]),
        0.0, 0.9999995);
    /* Do not let a longer decay remove most of the strike energy. The
       geometric mean keeps the coupling bounded while separating it from
       the resonator's current damping. */
    sympathetic_coupling[index] = sqrt(
        (1.0 - p->sympathetic_radius_closed[index]) *
        (1.0 - sympathetic_radius[index]));
    sympathetic_drive[index] = 0.060 * drive_open;
  }

  fdn_t60 = 0.22 + 1.25 * pow(p->body, 1.5) +
            0.65 * p->body * pedal_open;
  fdn_t60 = wg_clamp(fdn_t60, 0.18, 2.35);
  fdn_cutoff = wg_clamp(1800.0 + 6200.0 * p->body +
                                    800.0 * pedal_open,
                        700.0, 0.42 * sample_rate);
  for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
    const double delay_seconds =
        (double)p->body_lines[index].size / sample_rate;
    const double cutoff = wg_clamp(fdn_cutoff * fdn_tone_scale[index],
                                   500.0, 0.44 * sample_rate);
    fdn_feedback[index] = wg_clamp(
        exp(-WG_LN_1000 * delay_seconds / fdn_t60), 0.0, 0.995);
    fdn_lowpass[index] = exp(-WG_TWO_PI * cutoff / sample_rate);
  }
  input_dc_coefficient = 1.0 - exp(-WG_TWO_PI * 18.0 / sample_rate);
  output_dc_pole = exp(-WG_TWO_PI * 12.0 / sample_rate);

  for (sample = offset; sample < limit; sample++) {
    double input_l = (double)in_left[sample];
    double input_r = (double)in_right[sample];
    double mid;
    double side;
    double modal_left = 0.0;
    double modal_right = 0.0;
    double sympathetic_left = 0.0;
    double sympathetic_right = 0.0;
    double body_out[RESONANCE_BODY_LINES];
    double scattered[RESONANCE_BODY_LINES];
    double fdn_drive_left;
    double fdn_drive_right;
    double fdn_mid;
    double fdn_side;
    double fdn_left;
    double fdn_right;
    double wet_left;
    double wet_right;
    double filtered_left;
    double filtered_right;

    if (UNLIKELY(!isfinite(input_l))) {
      input_l = 0.0;
    }
    if (UNLIKELY(!isfinite(input_r))) {
      input_r = 0.0;
    }

    p->input_dc_left +=
        input_dc_coefficient * (input_l - p->input_dc_left);
    p->input_dc_right +=
        input_dc_coefficient * (input_r - p->input_dc_right);
    input_l -= p->input_dc_left;
    input_r -= p->input_dc_right;
    mid = 0.5 * (input_l + input_r);
    side = 0.5 * (input_l - input_r);

    for (index = 0U; index < RESONANCE_BODY_MODES; index++) {
      const double radius = body_radius[index];
      const double cosine = p->body_mode_cos[index];
      const double sine = p->body_mode_sin[index];
      const double old_real = p->body_mode_y1[index];
      const double old_imaginary = p->body_mode_y2[index];
      const double drive = mid + body_mode_side[index] * side;
      const double real =
          radius * (cosine * old_real - sine * old_imaginary) +
          2.0 * (1.0 - radius) * body_mode_gain[index] * drive;
      const double imaginary =
          radius * (sine * old_real + cosine * old_imaginary);
      p->body_mode_y1[index] = real;
      p->body_mode_y2[index] = imaginary;
      modal_left += p->body_mode_left[index] * real;
      modal_right += p->body_mode_right[index] * real;
    }

    for (index = 0U; index < SYMPATHETIC_STRINGS; index++) {
      const double radius = sympathetic_radius[index];
      const double cosine = p->sympathetic_cos[index];
      const double sine = p->sympathetic_sin[index];
      const double old_real = p->sympathetic_y1[index];
      const double old_imaginary = p->sympathetic_y2[index];
      const double drive = mid + p->sympathetic_input_side[index] * side;
      if (sympathetic_drive[index] <= 0.0 &&
          fabs(old_real) + fabs(old_imaginary) < 1.0e-18) {
        continue;
      }
      const double real =
          radius * (cosine * old_real - sine * old_imaginary) +
          2.0 * sympathetic_coupling[index] *
              sympathetic_drive[index] * drive;
      const double imaginary =
          radius * (sine * old_real + cosine * old_imaginary);
      p->sympathetic_y1[index] = real;
      p->sympathetic_y2[index] = imaginary;
      sympathetic_left += p->sympathetic_left[index] * real;
      sympathetic_right += p->sympathetic_right[index] * real;
    }
    sympathetic_left *= 0.15;
    sympathetic_right *= 0.15;

    fdn_drive_left = input_l + 0.42 * modal_left +
                     0.34 * sympathetic_left;
    fdn_drive_right = input_r + 0.42 * modal_right +
                      0.34 * sympathetic_right;
    fdn_mid = 0.5 * (fdn_drive_left + fdn_drive_right);
    fdn_side = 0.5 * (fdn_drive_left - fdn_drive_right);

    for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
      BODY_LINE *line = &p->body_lines[index];
      body_out[index] = line->data[line->write_index];
    }
    wg_hadamard8(body_out, scattered);
    for (index = 0U; index < RESONANCE_BODY_LINES; index++) {
      BODY_LINE *line = &p->body_lines[index];
      const double injection =
          fdn_injection[index] *
          (fdn_mid + fdn_input_side[index] * fdn_side);
      line->lowpass = fdn_lowpass[index] * line->lowpass +
                      (1.0 - fdn_lowpass[index]) * scattered[index];
      line->data[line->write_index] =
          injection + fdn_feedback[index] * line->lowpass;
      line->write_index++;
      if (line->write_index >= line->size) {
        line->write_index = 0U;
      }
    }

    fdn_left = 0.35355339059327376220 *
        (body_out[0] + body_out[1] - body_out[2] + body_out[3] -
         body_out[4] + body_out[5] + body_out[6] - body_out[7]);
    fdn_right = 0.35355339059327376220 *
        (body_out[0] - body_out[1] + body_out[2] + body_out[3] +
         body_out[4] - body_out[5] + body_out[6] - body_out[7]);

    wet_left = p->body *
        (0.46 * modal_left + 0.42 * sympathetic_left + 0.94 * fdn_left);
    wet_right = p->body *
        (0.46 * modal_right + 0.42 * sympathetic_right + 0.94 * fdn_right);
    filtered_left = wet_left - p->output_input_left +
                    output_dc_pole * p->output_state_left;
    filtered_right = wet_right - p->output_input_right +
                     output_dc_pole * p->output_state_right;
    p->output_input_left = wet_left;
    p->output_input_right = wet_right;
    p->output_state_left = filtered_left;
    p->output_state_right = filtered_right;

    if (UNLIKELY(!isfinite(filtered_left) || !isfinite(filtered_right))) {
      filtered_left = 0.0;
      filtered_right = 0.0;
      wg_resonance_clear(p);
    }
    block_level = fmax(block_level, fabs(input_l));
    block_level = fmax(block_level, fabs(input_r));
    block_level = fmax(block_level, fabs(filtered_left));
    block_level = fmax(block_level, fabs(filtered_right));
    out_left[sample] = (MYFLT)filtered_left;
    out_right[sample] = (MYFLT)filtered_right;
  }

  p->render_block_level = fmax(p->render_block_level, block_level);

  return OK;
}

static void wg_finish_resonance_block(WG_PIANO_STATE *p)
{
  if (p->render_block_level < 1.0e-11) {
    if (UINT32_MAX - p->quiet_samples < p->rendered_samples) {
      p->quiet_samples = UINT32_MAX;
    } else {
      p->quiet_samples += p->rendered_samples;
    }
    if (p->quiet_samples > (uint32_t)(2.0 * p->sample_rate)) {
      wg_resonance_clear(p);
    }
  } else {
    p->quiet_samples = 0U;
  }
  p->rendered_samples = 0U;
  p->render_block_level = 0.0;
}

static int32_t wg_renderer_precedes(OPDS *first, OPDS *second)
{
  INSDS *instance;

  for (instance = first->insdshead; instance != NULL;
       instance = instance->nxtact) {
    if (instance == second->insdshead) {
      return 1;
    }
  }
  return 0;
}

static int32_t wg_renderers_are_contiguous(CSOUND *csound,
                                           OPDS *first,
                                           OPDS *second)
{
  const OPARMS *options = csound->GetOParms(csound);
  INSDS *first_instance = first->insdshead;
  INSDS *second_instance = second->insdshead;
  const double sample_rate = (double)csound->GetEngineSr(csound);
  double boundary_error;
  int32_t spans_meet;

  if (options == NULL || !options->sampleAccurate || options->realtime ||
      first_instance == NULL || second_instance == NULL ||
      first_instance->instr != second_instance->instr ||
      first_instance->p1.value != second_instance->p1.value ||
      first_instance->ksmps != second_instance->ksmps ||
      first_instance->esr != second_instance->esr ||
      first_instance->xtratim != 0 || first_instance->p3.value <= FL(0.0) ||
      first_instance->no_end >= first_instance->ksmps ||
      second_instance->ksmps_offset >= second_instance->ksmps ||
      !isfinite(sample_rate) || sample_rate <= 0.0 ||
      !wg_renderer_precedes(first, second)) {
    return 0;
  }
  spans_meet =
      (first_instance->no_end == 0U &&
       second_instance->ksmps_offset == 0U) ||
      (first_instance->no_end > 0U &&
       first_instance->ksmps - first_instance->no_end ==
           second_instance->ksmps_offset);
  if (!spans_meet) {
    return 0;
  }
  boundary_error =
      (((double)first_instance->p2.value +
        (double)first_instance->p3.value) -
       (double)second_instance->p2.value) * sample_rate;
  return isfinite(boundary_error) && fabs(boundary_error) < 0.5;
}

static int32_t wg_claim_renderer(CSOUND *csound,
                                 WG_PIANO_STATE *state,
                                 OPDS *owner)
{
  int32_t claimed = 0;

  csound->LockMutex(state->resonance_lock);
  if (state->renderer_owner == NULL || state->renderer_owner == owner) {
    state->renderer_owner = owner;
    claimed = 1;
  } else if (state->renderer_successor == owner) {
    claimed = 1;
  } else if (state->renderer_successor == NULL &&
             wg_renderers_are_contiguous(
                 csound, state->renderer_owner, owner)) {
    state->renderer_successor = owner;
    claimed = 1;
  }
  csound->UnlockMutex(state->resonance_lock);
  if (!claimed) {
    return csound->InitError(
        csound,
        "hlolli_wg_piano_resonance: piano %d already has an output opcode\n",
        state->handle);
  }
  return OK;
}

static void wg_release_renderer(CSOUND *csound,
                                WG_PIANO_STATE *state,
                                OPDS *owner)
{
  if (state == NULL) {
    return;
  }
  csound->LockMutex(state->resonance_lock);
  if (state->renderer_retired == owner) {
    state->renderer_retired = NULL;
  }
  if (state->renderer_owner == owner) {
    state->renderer_owner = state->renderer_successor;
    state->renderer_successor = NULL;
  } else if (state->renderer_successor == owner) {
    state->renderer_successor = NULL;
  }
  csound->UnlockMutex(state->resonance_lock);
}

static int32_t wg_process_renderer(
    CSOUND *csound, OPDS *h,
    MYFLT *out_left, MYFLT *out_right,
    const MYFLT *in_left, const MYFLT *in_right,
    const MYFLT *kbody, const MYFLT *kpedal,
    WG_PIANO_STATE *state)
{
  const uint64_t epoch = csound->GetEngineKcounter(csound);
  const uint32_t offset = h->insdshead->ksmps_offset;
  const uint32_t limit =
      h->insdshead->ksmps - h->insdshead->ksmps_no_end;
  int32_t result;

  csound->LockMutex(state->resonance_lock);
  if (state->renderer_retired == h) {
    memset(out_left, 0, h->insdshead->ksmps * sizeof(MYFLT));
    memset(out_right, 0, h->insdshead->ksmps * sizeof(MYFLT));
    state->renderer_retired = NULL;
    csound->UnlockMutex(state->resonance_lock);
    return OK;
  }
  if (state->renderer_owner == h &&
      state->renderer_successor != NULL &&
      state->renderer_successor->insdshead->ksmps_offset == 0U) {
    memset(out_left, 0, h->insdshead->ksmps * sizeof(MYFLT));
    memset(out_right, 0, h->insdshead->ksmps * sizeof(MYFLT));
    state->renderer_owner = state->renderer_successor;
    state->renderer_successor = NULL;
    csound->UnlockMutex(state->resonance_lock);
    return OK;
  }
  if (state->renderer_successor == h && offset == 0U) {
    state->renderer_retired = state->renderer_owner;
    state->renderer_owner = h;
    state->renderer_successor = NULL;
  }
  if (state->renderer_owner != h) {
    const double start = (double)h->insdshead->p2.value;
    const double owner_start = state->renderer_owner != NULL
        ? (double)state->renderer_owner->insdshead->p2.value : -1.0;
    csound->UnlockMutex(state->resonance_lock);
    return csound->PerfError(
        csound, h,
        "hlolli_wg_piano_resonance: piano %d output handoff ran out of order "
        "(start %.9g, owner %.9g, offset %u)\n",
        state->handle, start, owner_start, offset);
  }
  if (!state->render_epoch_valid || state->render_epoch != epoch) {
    state->render_epoch = epoch;
    state->rendered_until = offset;
    state->rendered_samples = 0U;
    state->render_block_level = 0.0;
    state->render_epoch_valid = 1;
  }
  if (state->rendered_until != offset) {
    csound->UnlockMutex(state->resonance_lock);
    return csound->PerfError(
        csound, h,
        "hlolli_wg_piano_resonance: piano %d output spans overlap\n",
        state->handle);
  }
  result = wg_resonance_process(
      csound, h, out_left, out_right,
      in_left, in_right, kbody, kpedal, state);
  if (result == OK) {
    const int32_t continues =
        state->renderer_successor != NULL &&
        limit == state->renderer_successor->insdshead->ksmps_offset;
    state->rendered_until = limit;
    state->rendered_samples += limit - offset;
    if (continues) {
      state->renderer_owner = state->renderer_successor;
      state->renderer_successor = NULL;
    } else {
      wg_finish_resonance_block(state);
    }
  }
  csound->UnlockMutex(state->resonance_lock);
  return result;
}

static int32_t hlolli_wg_piano_resonance_bus_init(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_BUS *p)
{
  const uint32_t engine_ksmps = wg_engine_ksmps(csound);
  int32_t result;

  if (p->owns_renderer && p->piano != NULL) {
    wg_release_renderer(csound, p->piano, &p->h);
  }
  if (UNLIKELY(engine_ksmps == 0U ||
               p->h.insdshead->ksmps != engine_ksmps)) {
    p->piano = NULL;
    p->owns_renderer = 0;
    return csound->InitError(
        csound,
        "hlolli_wg_piano_resonance: persistent output requires engine ksmps %u\n",
        engine_ksmps);
  }
  p->piano = wg_get_default_piano(csound, engine_ksmps);
  p->owns_renderer = 0;
  if (UNLIKELY(p->piano == NULL)) {
    return csound->InitError(
        csound, "hlolli_wg_piano_resonance: cannot allocate default piano\n");
  }
  if (UNLIKELY(p->piano->send_ksmps != p->h.insdshead->ksmps)) {
    return csound->InitError(
        csound,
        "hlolli_wg_piano_resonance: default piano uses a different ksmps\n");
  }
  result = wg_claim_renderer(csound, p->piano, &p->h);
  if (result != OK) {
    return result;
  }
  p->owns_renderer = 1;
  result = wg_resonance_state_init(csound, &p->h, p->piano,
                                   p->kbody, p->kpedal);
  if (result != OK) {
    wg_release_renderer(csound, p->piano, &p->h);
    p->owns_renderer = 0;
  }
  return result;
}

static int32_t hlolli_wg_piano_resonance_bus_perf(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_BUS *p)
{
  return wg_process_renderer(
      csound, &p->h, p->out_left, p->out_right,
      p->in_left, p->in_right, p->kbody, p->kpedal, p->piano);
}

static int32_t hlolli_wg_piano_resonance_bus_deinit(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_BUS *p)
{
  if (p->owns_renderer) {
    wg_release_renderer(csound, p->piano, &p->h);
    p->owns_renderer = 0;
  }
  p->piano = NULL;
  return OK;
}

static int32_t hlolli_wg_piano_resonance_handle_init(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_HANDLE *p)
{
  const int32_t handle = wg_read_piano_handle(p->ipiano);
  int32_t result;

  if (p->owns_renderer && p->piano != NULL) {
    wg_release_renderer(csound, p->piano, &p->h);
  }
  p->piano = NULL;
  p->owns_renderer = 0;
  if (UNLIKELY(handle < 1)) {
    return csound->InitError(
        csound,
        "hlolli_wg_piano_resonance: piano handle must be a positive integer\n");
  }
  p->piano = wg_get_piano_by_handle(csound, handle);
  if (UNLIKELY(p->piano == NULL)) {
    return csound->InitError(
        csound, "hlolli_wg_piano_resonance: unknown piano handle %d\n",
        handle);
  }
  if (UNLIKELY(p->piano->send_ksmps != p->h.insdshead->ksmps)) {
    return csound->InitError(
        csound,
        "hlolli_wg_piano_resonance: piano %d requires engine ksmps %u\n",
        handle, p->piano->send_ksmps);
  }
  result = wg_claim_renderer(csound, p->piano, &p->h);
  if (result != OK) {
    return result;
  }
  p->owns_renderer = 1;
  result = wg_resonance_state_init(csound, &p->h, p->piano,
                                   p->kbody, p->kpedal);
  if (result != OK) {
    wg_release_renderer(csound, p->piano, &p->h);
    p->owns_renderer = 0;
  }
  return result;
}

static int32_t hlolli_wg_piano_resonance_handle_perf(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_HANDLE *p)
{
  const uint64_t epoch = csound->GetEngineKcounter(csound);
  const MYFLT *in_left = NULL;
  const MYFLT *in_right = NULL;

  csound->LockMutex(p->piano->send_lock);
  if (epoch > 0U) {
    const uint64_t wanted = epoch - 1U;
    const uint32_t slot = (uint32_t)(wanted & 1U);
    if (p->piano->send_epoch_valid[slot] &&
        p->piano->send_epoch[slot] == wanted) {
      in_left = p->piano->send_left[slot];
      in_right = p->piano->send_right[slot];
    }
  }
  csound->UnlockMutex(p->piano->send_lock);
  if (in_left == NULL) {
    memset(p->out_left, 0, p->h.insdshead->ksmps * sizeof(MYFLT));
    memset(p->out_right, 0, p->h.insdshead->ksmps * sizeof(MYFLT));
    in_left = p->out_left;
    in_right = p->out_right;
  }
  return wg_process_renderer(
      csound, &p->h, p->out_left, p->out_right,
      in_left, in_right, p->kbody, p->kpedal, p->piano);
}

static int32_t hlolli_wg_piano_resonance_handle_deinit(
    CSOUND *csound, HLOLLI_WG_PIANO_RESONANCE_HANDLE *p)
{
  if (p->owns_renderer) {
    wg_release_renderer(csound, p->piano, &p->h);
    p->owns_renderer = 0;
  }
  p->piano = NULL;
  return OK;
}

static OENTRY localops[] = {
    {"hlolli_wg_piano_create", sizeof(HLOLLI_WG_PIANO_CREATE), 0,
     "i", "", (SUBR)hlolli_wg_piano_create_init, NULL, NULL, NULL, 0},
    {"hlolli_wg_piano", sizeof(HLOLLI_WG_PIANO), 0,
     "aa", "kkkkkkkkkko", (SUBR)hlolli_wg_piano_init,
     (SUBR)hlolli_wg_piano_perf, (SUBR)hlolli_wg_piano_deinit, NULL, 0},
    /* Expose the hidden renderer write to Csound's worker-task graph. */
    {"hlolli_wg_piano_resonance",
     sizeof(HLOLLI_WG_PIANO_RESONANCE_BUS), _CW,
     "aa", "aakk", (SUBR)hlolli_wg_piano_resonance_bus_init,
     (SUBR)hlolli_wg_piano_resonance_bus_perf,
     (SUBR)hlolli_wg_piano_resonance_bus_deinit, NULL, 0},
    {"hlolli_wg_piano_resonance",
     sizeof(HLOLLI_WG_PIANO_RESONANCE_HANDLE), _CW,
     "aa", "ikk", (SUBR)hlolli_wg_piano_resonance_handle_init,
     (SUBR)hlolli_wg_piano_resonance_handle_perf,
     (SUBR)hlolli_wg_piano_resonance_handle_deinit, NULL, 0}};

LINKAGE
