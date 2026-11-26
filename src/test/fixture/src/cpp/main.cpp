#include "math/vec.h"

float scale(float x)
{
    return math::normalize(x) * 2;
}

int main()
{
    return (int)scale(3.0f);
}
