export const DEFAULT_C_SOURCE = `#include "csound.h"
#include <csdl.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  OPDS h;
  MYFLT *out;
  MYFLT *in;
  MYFLT *gain;
} IDEGAIN;

static int32_t idegain_perf(CSOUND *csound, IDEGAIN *p) {
  uint32_t offset = p->h.insdshead->ksmps_offset;
  uint32_t early = p->h.insdshead->ksmps_no_end;
  uint32_t limit = CS_KSMPS - early;

  if (offset) {
    memset(p->out, 0, offset * sizeof(MYFLT));
  }

  for (uint32_t index = offset; index < limit; index++) {
    p->out[index] = p->in[index] * *p->gain;
  }

  if (early) {
    memset(&p->out[limit], 0, early * sizeof(MYFLT));
  }

  return OK;
}

static OENTRY localops[] = {
  {
    "idegain",
    sizeof(IDEGAIN),
    0,
    "a",
    "ak",
    NULL,
    (SUBR) idegain_perf
  }
};

LINKAGE
`

export const DEFAULT_CPP_SOURCE = `#include <modload.h>

struct IdeGain : csnd::Plugin<1, 2> {
  int32_t aperf() {
    auto *out = outargs(0);
    const auto *in = inargs(0);
    const auto gain = inargs[1];

    for (auto index = offset; index < nsmps; index++) {
      out[index] = in[index] * gain;
    }

    return OK;
  }
};

void csnd::on_load(Csound *csound) {
  csnd::plugin<IdeGain>(
    csound,
    "idegain",
    "a",
    "ak",
    csnd::thread::a
  );
}
`

export const DEFAULT_CSD_SOURCE = `<CsoundSynthesizer>
<CsOptions>
-odac -d -m128
</CsOptions>
<CsInstruments>
sr = 48000
ksmps = 64
nchnls = 2
0dbfs = 1

instr 1
  aTone vco2 0.18, cpsmidinn(p4)
  kGain = 0.65
  aPlugin idegain aTone, kGain
  aEnv linsegr 0, 0.01, 1, 0.12, 0
  outs aPlugin * aEnv, aPlugin * aEnv
endin
</CsInstruments>
<CsScore>
i 1 0.0 1.2 57
i 1 1.0 1.2 64
i 1 2.0 1.2 67
i 1 3.0 1.8 72
e
</CsScore>
</CsoundSynthesizer>
`
