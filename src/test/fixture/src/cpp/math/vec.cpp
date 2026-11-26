#include "vec.h"

namespace math {
float length(float x)
{
    return x < 0 ? -x : x;
}

float normalize(float x)
{
    return x / length(x);
}
}
