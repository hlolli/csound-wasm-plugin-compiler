/*
  hlolli_wg_piano - a struck, dispersive piano-string model for Csound.

  The signal path follows the reduced real-time models described by Balazs
  Bank and Juliette Chabassier in "Model-based digital pianos: from physics
  to sound synthesis" (2018):

       felt hammer -> offset, drifting unisons -> nonlinear string color
                   -> short hammer modes -> feedback-delay soundboard

  This is a new implementation from the equations and design ideas in that
  paper's reduced models. The paper appeared in 2019; its manuscript dates
  from 2018. This opcode has no samples, tables, files, or platform-specific
  calls, so the same source builds as a native plugin and as a WASI plugin.

  SPDX-License-Identifier: MIT
*/

#include <csdl.h>

#include <math.h>
#include <stdint.h>
#include <string.h>

#define WG_STRINGS 3
#define DISPERSION_STAGES 4
#define BODY_LINES 4
#define NONLINEAR_MODES 2
#define FELT_MODES 3

#define WG_PI 3.14159265358979323846264338327950288
#define WG_TWO_PI 6.28318530717958647692528676655900576
#define WG_LN_1000 6.90775527898213705205397436405309262
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
  double hammer_amplitude;
  double hammer_hit_hardness;
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
  double strange_phase;
  double output_input_left;
  double output_input_right;
  double output_state_left;
  double output_state_right;
  int32_t tuning_initialized;
} HLOLLI_WG_PIANO;

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
  double contact_seconds;
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
  p->hammer_sample = 0U;
  p->hammer_amplitude =
      0.62 * pow(velocity, 1.28) * (0.76 + 0.34 * hardness);
  p->hammer_hit_hardness = hardness;
  wg_randomize_strike(p);
}

static double wg_hammer_tick(HLOLLI_WG_PIANO *p)
{
  double phase;
  double window;
  double felt_noise;
  double noise_cut;
  double force;

  if (p->hammer_sample >= p->hammer_samples) {
    return 0.0;
  }

  phase = ((double)p->hammer_sample + 0.5) / (double)p->hammer_samples;
  window = sin(WG_PI * phase);
  window = pow(window, 0.90 + 1.65 * p->hammer_hit_hardness);

  /* Felt makes a small, filtered shock. Hard felt admits more high band. */
  noise_cut = 0.08 + 0.72 * p->hammer_hit_hardness;
  p->hammer_noise_lowpass +=
      noise_cut * (wg_white_noise(p) - p->hammer_noise_lowpass);
  felt_noise = p->hammer_noise_lowpass;
  force = p->hammer_amplitude * window *
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
  memset(p->felt_y1, 0, sizeof(p->felt_y1));
  memset(p->felt_y2, 0, sizeof(p->felt_y2));
  p->nonlinear_dc = 0.0;
  memset(p->nonlinear_y1, 0, sizeof(p->nonlinear_y1));
  memset(p->nonlinear_y2, 0, sizeof(p->nonlinear_y2));
  p->board_dc = 0.0;
  p->radiation_lowpass = 0.0;
  p->radiation_dc = 0.0;
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
  size_t total_doubles;
  uint32_t rail_size;
  uint32_t body_sizes[BODY_LINES];
  uint32_t index;

  p->sample_rate = (double)CS_ESR;
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
  p->hammer_amplitude = 0.0;
  p->hammer_hit_hardness = p->hardness;
  p->hammer_noise_lowpass = 0.0;
  memset(p->hammer_excitation_lowpass, 0,
         sizeof(p->hammer_excitation_lowpass));
  memset(p->hammer_excitation_lowpass2, 0,
         sizeof(p->hammer_excitation_lowpass2));
  {
    const uint64_t start_sample =
        (uint64_t)csound->GetCurrentTimeSamples(csound);
    const uint64_t instance_salt = (uint64_t)(uintptr_t)(void *)p;
    p->random_state = 0x6d2b79f5U ^ (uint32_t)start_sample ^
                      (uint32_t)(start_sample >> 32U) ^
                      (uint32_t)instance_salt ^
                      (uint32_t)(instance_salt >> 32U) ^
                      (uint32_t)(initial_frequency * 655.0);
  }
  if (p->random_state == 0U) {
    p->random_state = 0x9e3779b9U;
  }

  for (index = 0U; index < WG_STRINGS; index++) {
    p->unison_static_cents[index] = 0.0;
    p->unison_drift_phase[index] =
        0.5 + 0.5 * wg_white_noise(p);
    p->unison_drift_rate[index] =
        0.012 + 0.016 * (0.5 + 0.5 * wg_white_noise(p));
    p->unison_strike_delay[index] = 0.0;
    p->unison_strike_level[index] = 1.0;
    p->unison_comb_scale[index] = 1.0;
  }
  p->note_tuning_cents = 0.0;
  for (index = 0U; index < FELT_MODES; index++) {
    p->felt_mode_scale[index] =
        1.0 + 0.018 * wg_white_noise(p);
  }
  memset(p->felt_y1, 0, sizeof(p->felt_y1));
  memset(p->felt_y2, 0, sizeof(p->felt_y2));

  p->nonlinear_dc = 0.0;
  memset(p->nonlinear_y1, 0, sizeof(p->nonlinear_y1));
  memset(p->nonlinear_y2, 0, sizeof(p->nonlinear_y2));
  p->board_dc = 0.0;
  p->radiation_lowpass = 0.0;
  p->radiation_dc = 0.0;
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

  for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
    double frequency = wg_clamp(string_frequency[string_index], 20.0,
                                0.43 * sample_rate);
    double period = sample_rate / frequency;
    double note_distance = fabs(log(frequency / 220.0) / log(2.0));
    double dispersion_scale = 0.78 + 0.06 * wg_clamp(note_distance, 0.0, 5.0);
    double coefficient =
        -0.008 - 0.24 * p->stiffness * p->stiffness * dispersion_scale;
    double omega;
    double allpass_phase_delay;
    double loss_phase_delay;
    double loss_magnitude;
    double dc_filter_real;
    double dc_filter_imaginary;
    double dc_filter_magnitude;
    double dc_filter_phase_delay;
    double interpolation_magnitude;
    double loop_compensation;
    double wanted_round_trip;
    double measured_round_trip;
    double wanted_delay;
    double natural_t60;
    double t60;

    if (p->strange > 0.0) {
      coefficient -= 0.42 * p->strange * p->strange;
    } else {
      coefficient += 0.06 * p->strange;
    }
    coefficient = wg_clamp(coefficient, -0.82, 0.20);
    allpass_coefficient[string_index] = coefficient;

    loss_amount[string_index] =
        0.08 + 0.32 * (1.0 - p->decay) +
        0.12 * wg_clamp(frequency / 4200.0, 0.0, 1.0);
    if (p->strange < 0.0) {
      loss_amount[string_index] += 0.22 * (-p->strange);
    }
    /* A short string completes far more loops each second. Scale its
       one-zero loss down so the requested T60 still controls the main mode. */
    loss_amount[string_index] /=
        1.0 + pow(frequency / 650.0, 2.0);
    loss_amount[string_index] =
        wg_clamp(loss_amount[string_index], 0.0015, 0.82);

    omega = WG_TWO_PI * frequency / sample_rate;
    loop_dc_pole[string_index] =
        exp(-WG_TWO_PI * WG_LOOP_DC_RATIO * frequency / sample_rate);
    loop_dc_normalization[string_index] =
        0.5 * (1.0 + loop_dc_pole[string_index]);
    allpass_phase_delay =
        2.0 * atan2((1.0 - coefficient) * sin(0.5 * omega),
                    (1.0 + coefficient) * cos(0.5 * omega)) /
        omega;
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
        wg_clamp(period -
                     (double)DISPERSION_STAGES * allpass_phase_delay -
                     loss_phase_delay - dc_filter_phase_delay,
                 2.05, (double)p->strings[string_index].size - 3.0);
    delay_target[string_index] = wanted_delay;

    natural_t60 = 1.1 + 13.0 / (1.0 + pow(frequency / 520.0, 0.72));
    t60 = natural_t60 * (0.22 + 2.15 * p->decay * p->decay);
    if (!key_down) {
      t60 = 0.055 + p->pedal * (1.30 * t60 - 0.055);
    } else {
      t60 *= 1.0 + 0.35 * p->pedal;
    }
    t60 *= 1.0 + 0.35 * p->strange * p->strange;
    t60 = wg_clamp(t60, 0.035, 45.0);
    {
      const double loss_current = 1.0 - 0.5 * loss_amount[string_index];
      const double loss_previous = 0.5 * loss_amount[string_index];
      loss_magnitude =
          sqrt(loss_current * loss_current +
               loss_previous * loss_previous +
               2.0 * loss_current * loss_previous * cos(omega));
    }
    interpolation_magnitude = wg_cubic_magnitude(wanted_delay, omega);
    wanted_round_trip = exp(-WG_LN_1000 / (frequency * t60));
    measured_round_trip =
        wg_clamp(loss_magnitude * interpolation_magnitude *
                     dc_filter_magnitude,
                 0.25, 1.25);
    /* Fractional interpolation can shorten the top notes by many decibels
       per second. Correct part of that loss in the treble. The mixed
       highpass removes the zero-frequency loop mode before gain can exceed
       one; strange backs away from the correction. */
    loop_compensation =
        0.90 * treble_amount * (1.0 - 0.50 * fabs(p->strange));
    loop_gain[string_index] =
        wg_clamp(wanted_round_trip /
                     pow(measured_round_trip, loop_compensation),
                 0.0, 1.003);
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
      (0.30 + 0.65 * treble_amount) *
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

  /* Let the board keep radiating after the string's first attack. The old
     normal setting was near 0.80, which made this response end in a few tenths
     of a second and left the direct rails exposed. It remains below unity. */
  body_feedback =
      0.64 + 0.28 * p->body + 0.045 * p->decay + 0.025 * p->pedal;
  body_feedback += 0.04 * p->strange * p->strange;
  body_feedback = wg_clamp(body_feedback, 0.54, 0.965);
  {
    double body_cutoff = 1500.0 + 6100.0 * p->body +
                         3100.0 * p->hardness +
                         5200.0 * (p->strange > 0.0 ? p->strange : 0.0);
    body_cutoff = wg_clamp(body_cutoff, 500.0, 0.42 * sample_rate);
    body_lowpass_coefficient = exp(-WG_TWO_PI * body_cutoff / sample_rate);
  }
  body_mix = 0.31 * p->body * (1.0 + 0.22 * treble_amount);
  direct_body_mix =
      (0.025 + 0.13 * p->body) * (0.12 + 0.88 * treble_amount);
  dry_mix =
      0.14 * (1.0 - 0.70 * treble_amount * (0.35 + 0.65 * p->body));
  body_chaos = 0.72 * fabs(p->strange);
  hammer_body_gain =
      0.015 + 0.085 / (1.0 + pow(p->frequency / 1600.0, 2.0)) +
      0.055 * treble_amount * (0.45 + 0.55 * p->body);
  {
    double radiation_cutoff =
        2600.0 + 5200.0 * p->body + 4200.0 * p->hardness;
    radiation_cutoff =
        wg_clamp(radiation_cutoff, 1200.0, 0.42 * sample_rate);
    radiation_lowpass_coefficient =
        exp(-WG_TWO_PI * radiation_cutoff / sample_rate);
  }

  nonlinear_mix =
      0.007 * wg_clamp((720.0 - p->frequency) / 680.0, 0.0, 1.0) +
      0.11 * pow(fabs(p->strange), 1.55);
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
    double loop_signal[WG_STRINGS];
    double loop_average = 0.0;
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
          0.72 + 0.16 * p->hardness + 0.10 * fabs(p->strange),
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

      for (stage = 0U; stage < DISPERSION_STAGES; stage++) {
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

    for (string_index = 0U; string_index < WG_STRINGS; string_index++) {
      WG_STRING *string = &p->strings[string_index];
      const double rail_coupling =
          coupling * string_weight[string_index];
      const double mixed =
          (1.0 - rail_coupling) * loop_signal[string_index] +
          rail_coupling * loop_average;
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
    p->nonlinear_dc += 0.0007 * (quadratic - p->nonlinear_dc);
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

    p->board_dc += 0.0012 * (bridge - p->board_dc);
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
    p->radiation_dc +=
        0.0012 * (p->radiation_lowpass - p->radiation_dc);
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
                    0.99935 * p->output_state_left;
    filtered_right = result_right - p->output_input_right +
                     0.99935 * p->output_state_right;
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

  return OK;
}

static OENTRY localops[] = {
    {"hlolli_wg_piano", sizeof(HLOLLI_WG_PIANO), 0,
     "aa", "kkkkkkkkkk", (SUBR)hlolli_wg_piano_init,
     (SUBR)hlolli_wg_piano_perf, NULL}};

LINKAGE
