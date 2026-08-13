<CsoundSynthesizer>
<CsOptions>
-n -d -m0
</CsOptions>
<CsInstruments>
sr = 48000
ksmps = 32
nchnls = 2
0dbfs = 1

giViolin hlolli_wg_violin_create "generic_violin"
gaLeft init 0
gaRight init 0

instr Voice
  kFrequency linseg 293.664768, p3, 329.627557
  kForce linseg 0.32, p3 * 0.3, 0.58, p3 * 0.7, 0.44
  kSpeed linseg 0.42, p3 * 0.55, -0.38, p3 * 0.45, -0.31
  aLeft, aRight hlolli_wg_violin \
      1, kFrequency, kForce, kSpeed, 0.16, \
      10, 5.1, 0, 0, 0, 2, giViolin
  gaLeft += aLeft
  gaRight += aRight
endin

instr Body
  aLeft, aRight hlolli_wg_violin_resonance \
      giViolin, 0.72, 0.45, 0
  gaLeft += aLeft
  gaRight += aRight
endin

instr Output
  outs gaLeft, gaRight
  clear gaLeft, gaRight
endin

</CsInstruments>
<CsScore>
i "Voice" 0 0.75
i "Body" 0 1.0
i "Output" 0 1.0
e
</CsScore>
</CsoundSynthesizer>
