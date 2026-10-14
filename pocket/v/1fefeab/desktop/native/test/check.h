#pragma once
#include <cmath>
#include <cstdio>
extern int gFails, gChecks;
#define CHECK(c)                                                                  \
  do {                                                                            \
    gChecks++;                                                                    \
    if (!(c)) { gFails++; fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } \
  } while (0)
#define CHECK_NEAR(a, b, eps) CHECK(std::fabs((double)(a) - (double)(b)) <= (eps))
